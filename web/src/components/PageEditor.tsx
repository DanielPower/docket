import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { api, fileUrl } from "../api";
import { cx } from "../cx";
import { useAppData } from "../data";
import {
  canvasTransform, describeChanges, detectEdges, flipItemH, flipItemV, isChanged, rotateItem, startItems, toOp, type EditItem,
} from "../pageEdits";
import type { CropBox, DocumentDetail } from "../types";
import ui from "../ui.module.css";
import { Icon } from "./Icon";
import styles from "./PageEditor.module.css";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** A page rendered once, as shown (after its own rotation). */
type Bitmap = { canvas: HTMLCanvasElement; w: number; h: number };

/** Longest side of a thumbnail bitmap, in pixels. */
const THUMB_PX = 420;
/** Longest side of the bitmap the crop view works on. */
const CROP_PX = 1600;

/**
 * Edit pages: a grid of the document's pages to rotate, flip, straighten,
 * crop, reorder and remove, with every pending change listed beside it.
 * Nothing is written until Save. This module pulls in PDF.js; load it lazily.
 */
export default function PageEditor({ doc, onClose, onSaved }: { doc: DocumentDetail; onClose: () => void; onSaved: (reanalyze: boolean) => void }) {
  const { toast } = useAppData();
  const pdf = useRef<PDFDocumentProxy | null>(null);
  const [bitmaps, setBitmaps] = useState<Array<Bitmap | null>>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [items, setItemsRaw] = useState<EditItem[]>([]);
  const history = useRef<EditItem[][]>([]);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const anchor = useRef<number | null>(null);
  const [cropKey, setCropKey] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [reanalyze, setReanalyze] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  /** Changes items, keeping the old state for Undo. */
  const setItems = useCallback((fn: (prev: EditItem[]) => EditItem[]) => {
    setItemsRaw((prev) => {
      const next = fn(prev);
      if (next !== prev) history.current.push(prev);
      return next;
    });
    setConfirmCancel(false);
  }, []);
  const undo = useCallback(() => {
    const prev = history.current.pop();
    if (prev) setItemsRaw(prev);
  }, []);

  // Load the PDF and render small bitmaps of every page.
  useEffect(() => {
    let cancelled = false;
    const task = pdfjs.getDocument({ url: fileUrl(doc.id, "archive", false, doc.fileVersion) });
    task.promise
      .then(async (d) => {
        if (cancelled) return;
        pdf.current = d;
        setItemsRaw(startItems(d.numPages));
        history.current = [];
        setBitmaps(Array(d.numPages).fill(null));
        for (let i = 1; i <= d.numPages && !cancelled; i++) {
          const bmp = await renderPage(d, i, THUMB_PX);
          if (!cancelled) setBitmaps((b) => b.map((x, j) => (j === i - 1 ? bmp : x)));
        }
      })
      .catch((e: Error) => { if (!cancelled) setLoadError(e.message); });
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [doc.id, doc.fileVersion]);

  const changes = useMemo(() => describeChanges(items), [items]);
  const kept = items.filter((it) => !it.removed);
  const selected = items.filter((it) => sel.has(it.key) && !it.removed);

  const act = useCallback((fn: (it: EditItem) => EditItem, keys?: number[]) => {
    const on = new Set(keys ?? [...sel]);
    setItems((prev) => prev.map((it) => (on.has(it.key) && !it.removed ? fn(it) : it)));
  }, [sel, setItems]);

  const remove = useCallback((keys?: number[]) => {
    const on = new Set(keys ?? [...sel]);
    setItems((prev) => {
      if (prev.filter((it) => !it.removed && !on.has(it.key)).length === 0) {
        toast("A document needs at least one page.", "error");
        return prev;
      }
      return prev.map((it) => (on.has(it.key) ? { ...it, removed: true } : it));
    });
    setSel((s) => new Set([...s].filter((k) => !on.has(k))));
  }, [sel, setItems, toast]);

  const restore = (key: number) => setItems((prev) => prev.map((it) => (it.key === key ? { ...it, removed: false } : it)));

  const undoChange = (key: number | "order") => {
    if (key === "order") setItems((prev) => [...prev].sort((a, b) => a.from - b.from));
    else setItems((prev) => prev.map((it) => (it.key === key ? { ...it, r: 0, m: false, s: 0, crop: null, removed: false } : it)));
  };
  const undoAll = () => {
    setItems(() => startItems(items.length));
    setSel(new Set());
  };

  const move = useCallback((key: number, before: number | null) => {
    setItems((prev) => {
      const it = prev.find((x) => x.key === key);
      if (!it || key === before) return prev;
      const rest = prev.filter((x) => x.key !== key);
      const at = before === null ? rest.length : rest.findIndex((x) => x.key === before);
      const next = [...rest.slice(0, at), it, ...rest.slice(at)];
      return next.every((x, i) => x === prev[i]) ? prev : next;
    });
  }, [setItems]);

  const click = (key: number, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }, touch: boolean) => {
    if (touch || e.ctrlKey || e.metaKey) {
      setSel((s) => {
        const n = new Set(s);
        if (n.has(key)) n.delete(key);
        else n.add(key);
        return n;
      });
    } else if (e.shiftKey && anchor.current !== null) {
      const keys = items.map((it) => it.key);
      const [a, b] = [keys.indexOf(anchor.current), keys.indexOf(key)].sort((x, y) => x - y);
      setSel(new Set(items.slice(a, b + 1).filter((it) => !it.removed).map((it) => it.key)));
      return;
    } else {
      setSel((s) => (s.size === 1 && s.has(key) ? new Set() : new Set([key])));
    }
    anchor.current = key;
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.editPages(doc.id, kept.map(toOp));
      onSaved(reanalyze);
    } catch (e) {
      toast((e as Error).message, "error");
      setSaving(false);
    }
  };

  const cancel = () => {
    if (changes.length && !confirmCancel) setConfirmCancel(true);
    else onClose();
  };

  // Keys: R / Shift+R rotate, H / V flip, C crop, Delete remove, Ctrl+A all, Ctrl+Z undo, Esc cancel.
  useEffect(() => {
    if (cropKey !== null) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]") || saving) return;
      const k = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && k === "z") { e.preventDefault(); undo(); return; }
      if (mod && k === "a") { e.preventDefault(); setSel(new Set(items.filter((it) => !it.removed).map((it) => it.key))); return; }
      if (mod || e.altKey) return;
      if (k === "escape") { if (sel.size) setSel(new Set()); else cancel(); return; }
      if (!sel.size) return;
      if (k === "r") act((it) => rotateItem(it, e.shiftKey ? 270 : 90));
      else if (k === "h") act(flipItemH);
      else if (k === "v") act(flipItemV);
      else if (k === "c" && selected.length === 1) setCropKey(selected[0].key);
      else if (k === "delete" || k === "backspace") remove();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const cropItem = items.find((it) => it.key === cropKey) ?? null;
  const none = selected.length === 0;
  const reread = changes.filter((c) => c.kind === "edit").length;

  const changeList = (
    <>
      <div className={styles.shead}>
        Changes <span className={ui.mono}>{changes.length}</span>
        <span className={ui.spacer} />
        {changes.length > 0 && <button className={cx(ui.compact, ui.ghost)} onClick={undoAll} disabled={saving}>Undo all</button>}
      </div>
      <div className={styles.chlist}>
        {changes.length ? changes.map((c) => (
          <div key={c.key} className={cx(styles.chrow, c.kind === "removed" && styles.chRemoved, c.kind === "order" && styles.chOrder)}>
            <Icon name={c.kind === "removed" ? "trash" : c.kind === "order" ? "up" : "pages"} size={16} />
            <span className={ui.grow}>{c.text}</span>
            <button className={cx(ui.compact, ui.ghost)} onClick={() => undoChange(c.key)} disabled={saving}><Icon name="undo" size={14} /> Undo</button>
          </div>
        )) : <div className={styles.chempty}>No changes yet. Select pages, then rotate, flip, crop or remove them, or drag them into a new order.</div>}
      </div>
      <div className={styles.shead}>When you save</div>
      <ul className={styles.eff}>
        <li><Icon name="documents" size={16} /><span>Writes a new searchable PDF with <b>{kept.length} page{kept.length === 1 ? "" : "s"}</b>{kept.length !== items.length && <> (now {items.length})</>}.</span></li>
        <li><Icon name="search" size={16} /><span>{reread ? <>Reads the text again, so search and value highlights match the turned or cropped pages.</> : <>Reads the text again for search.</>}</span></li>
        <li><Icon name="objects" size={16} /><span>Keeps the title and details as they are.</span></li>
        <li><Icon name="undo" size={16} /><span>The original upload isn't changed. <b>Revert to original</b> in the ⋯ menu undoes every page edit.</span></li>
      </ul>
      {doc.status === "filed" && (
        <label className={cx(ui.inline, styles.check)}>
          <input type="checkbox" checked={reanalyze} onChange={(e) => setReanalyze(e.target.checked)} /> Re-analyze after saving (sends it back to the inbox)
        </label>
      )}
      <div className={styles.saveRow}>
        <button className={ui.primary} disabled={!changes.length || saving} onClick={save}>
          {saving ? "Saving, reading the text…" : `Save ${changes.length} change${changes.length === 1 ? "" : "s"}`}
        </button>
        <button onClick={cancel} disabled={saving}>{confirmCancel ? "Discard changes?" : "Cancel"}</button>
      </div>
    </>
  );

  return (
    <div className={styles.root}>
      <section className={styles.left}>
        {/* Phone header */}
        <div className={styles.phead}>
          <button className={ui.ghost} onClick={cancel} disabled={saving}>{confirmCancel ? "Discard?" : "Cancel"}</button>
          <span className={styles.ptitle}>{cropItem ? `Crop page ${cropItem.from}` : "Edit pages"}</span>
          {!cropItem && <button className={ui.primary} disabled={!changes.length || saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>}
        </div>
        {cropItem && bitmaps[cropItem.from - 1] ? (
          <CropView
            key={cropItem.key}
            item={cropItem}
            pdf={pdf.current}
            onCancel={() => setCropKey(null)}
            onDone={(s, crop) => {
              setItems((prev) => prev.map((it) => (it.key === cropItem.key ? { ...it, s, crop } : it)));
              setCropKey(null);
            }}
          />
        ) : (
          <>
            <div className={styles.toolbar}>
              <span className={styles.mode}>EDIT PAGES</span>
              <span className={cx(ui.small, ui.muted, styles.selCount)}>{none ? "Click a page to select it" : `${selected.length} selected`}</span>
              <button className={cx(ui.compact, ui.ghost)} onClick={() => setSel(new Set(kept.map((it) => it.key)))}>Select all</button>
              <span className={styles.sep} />
              <span className={styles.grp}>
                <button className={ui.compact} disabled={none} onClick={() => act((it) => rotateItem(it, 270))} title="Rotate left (Shift+R)"><Icon name="rotateLeft" size={15} /> Left</button>
                <button className={ui.compact} disabled={none} onClick={() => act((it) => rotateItem(it, 90))} title="Rotate right (R)"><Icon name="rotateRight" size={15} /> Right</button>
              </span>
              <span className={styles.grp}>
                <button className={ui.compact} disabled={none} onClick={() => act(flipItemH)} title="Flip left to right (H)" aria-label="Flip left to right"><Icon name="flipH" size={15} /></button>
                <button className={ui.compact} disabled={none} onClick={() => act(flipItemV)} title="Flip top to bottom (V)" aria-label="Flip top to bottom"><Icon name="flipV" size={15} /></button>
              </span>
              <button className={ui.compact} disabled={selected.length !== 1} onClick={() => setCropKey(selected[0].key)} title="Crop and straighten (C)"><Icon name="crop" size={15} /> Crop</button>
              <button className={cx(ui.compact, ui.danger)} disabled={none} onClick={() => remove()} title="Remove (Delete)"><Icon name="trash" size={15} /> Remove</button>
              <span className={ui.spacer} />
              <span className={cx(ui.small, ui.muted, styles.hint)}>Drag pages to reorder</span>
            </div>
            {/* Phone: selection and the change count */}
            <div className={styles.psub}>
              <span>{none ? "Tap pages to select" : `${selected.length} selected`}</span>
              <button className={cx(ui.compact, ui.ghost)} onClick={() => setSel(new Set(kept.map((it) => it.key)))}>Select all</button>
              <span className={ui.spacer} />
              {changes.length > 0 && <button className={cx(ui.link, styles.pchanges)} onClick={() => setSheetOpen(true)}>{changes.length} change{changes.length === 1 ? "" : "s"} ›</button>}
            </div>
            <Grid
              items={items}
              bitmaps={bitmaps}
              sel={sel}
              error={loadError}
              onClick={click}
              onMove={move}
              onRotate={(key, turn) => act((it) => rotateItem(it, turn), [key])}
              onRemove={(key) => remove([key])}
              onRestore={restore}
            />
            <div className={styles.pbar}>
              <button disabled={none} onClick={() => act((it) => rotateItem(it, 270))}><Icon name="rotateLeft" size={20} />Left</button>
              <button disabled={none} onClick={() => act((it) => rotateItem(it, 90))}><Icon name="rotateRight" size={20} />Right</button>
              <button disabled={none} onClick={() => act(flipItemH)}><Icon name="flipH" size={20} />Flip ↔</button>
              <button disabled={none} onClick={() => act(flipItemV)}><Icon name="flipV" size={20} />Flip ↕</button>
              <button disabled={selected.length !== 1} onClick={() => setCropKey(selected[0].key)}><Icon name="crop" size={20} />Crop</button>
              <button className={ui.danger} disabled={none} onClick={() => remove()}><Icon name="trash" size={20} />Remove</button>
            </div>
          </>
        )}
      </section>
      <section className={styles.right}>
        <div className={cx(ui.muted, ui.small)}>{doc.originalFilename}</div>
        <div>
          <h2 className={styles.title}>Edit pages</h2>
          <div className={cx(ui.muted, ui.small)}>{doc.title} · {items.length} page{items.length === 1 ? "" : "s"}</div>
        </div>
        {changeList}
        <span className={ui.spacer} />
        <div className={styles.shead}>Keys</div>
        <div className={styles.keys}>
          <kbd>R</kbd><span>Rotate right</span><kbd>Shift R</kbd><span>Rotate left</span>
          <kbd>H</kbd><span>Flip left to right</span><kbd>V</kbd><span>Flip top to bottom</span>
          <kbd>C</kbd><span>Crop</span><kbd>Del</kbd><span>Remove</span>
          <kbd>Ctrl A</kbd><span>Select all</span><kbd>Ctrl Z</kbd><span>Undo</span>
        </div>
      </section>
      {sheetOpen && (
        <div className={styles.sheetBackdrop} onClick={() => setSheetOpen(false)}>
          <div className={styles.sheet} onClick={(e) => e.stopPropagation()}>
            <span className={styles.grab} />
            {changeList}
          </div>
        </div>
      )}
    </div>
  );
}

function Grid(props: {
  items: EditItem[];
  bitmaps: Array<Bitmap | null>;
  sel: Set<number>;
  error: string | null;
  onClick: (key: number, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }, touch: boolean) => void;
  onMove: (key: number, before: number | null) => void;
  onRotate: (key: number, turn: 90 | 270) => void;
  onRemove: (key: number) => void;
  onRestore: (key: number) => void;
}) {
  const { items, bitmaps, sel } = props;
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ key: number; before: number | null; x: number; y: number } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const propsRef = useRef(props);
  propsRef.current = props;

  /** The cell under a point, and whether the drop goes before it or after it. */
  const target = (x: number, y: number): number | null | undefined => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-key]");
    if (!el) return undefined;
    const r = el.getBoundingClientRect();
    const key = Number(el.dataset.key);
    if (x < r.left + r.width / 2) return key;
    const list = propsRef.current.items;
    const next = list[list.findIndex((it) => it.key === key) + 1];
    return next ? next.key : null;
  };

  // Touch: a long press picks a page up, then it follows the finger.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let timer = 0;
    let start: { key: number; x: number; y: number } | null = null;
    const onStart = (e: TouchEvent) => {
      const cell = (e.target as HTMLElement).closest<HTMLElement>("[data-key]");
      if (!cell || e.touches.length !== 1 || (e.target as HTMLElement).closest("button")) return;
      const t = e.touches[0];
      start = { key: Number(cell.dataset.key), x: t.clientX, y: t.clientY };
      timer = window.setTimeout(() => {
        if (start) setDrag({ key: start.key, before: start.key, x: start.x, y: start.y });
        navigator.vibrate?.(15);
      }, 380);
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!dragRef.current) {
        if (start && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 8) { clearTimeout(timer); start = null; }
        return;
      }
      e.preventDefault(); // no scrolling while carrying a page
      const before = target(t.clientX, t.clientY);
      setDrag((d) => d && { ...d, x: t.clientX, y: t.clientY, before: before === undefined ? d.before : before });
    };
    const onEnd = () => {
      clearTimeout(timer);
      start = null;
      const d = dragRef.current;
      if (d) {
        propsRef.current.onMove(d.key, d.before);
        setDrag(null);
      }
    };
    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  // Mouse: press and move a few pixels to drag.
  const mouseDown = (key: number, e: ReactPointerEvent) => {
    if (e.pointerType !== "mouse" || e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      moved = true;
      const before = target(ev.clientX, ev.clientY);
      setDrag((d) => ({ key, x: ev.clientX, y: ev.clientY, before: before === undefined ? (d?.before ?? key) : before }));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const d = dragRef.current;
      if (moved && d) {
        propsRef.current.onMove(d.key, d.before);
        setDrag(null);
        // Swallow the click that follows the drag.
        window.addEventListener("click", (ce) => ce.stopPropagation(), { capture: true, once: true });
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  if (props.error) return <div className={styles.canvas}><p className={styles.message}>Couldn't load the pages: {props.error}</p></div>;
  return (
    <div className={styles.canvas}>
      <div ref={box} className={cx(styles.grid, sel.size > 1 && styles.multi)}>
        {items.map((it) => {
          const bmp = bitmaps[it.from - 1];
          const changed = isChanged(it);
          return (
            <div
              key={it.key}
              data-key={it.key}
              className={cx(
                styles.cell,
                sel.has(it.key) && styles.sel,
                it.removed && styles.removed,
                drag?.key === it.key && styles.dragging,
                drag && drag.before === it.key && drag.key !== it.key && styles.dropBefore,
              )}
              onPointerDown={(e) => mouseDown(it.key, e)}
            >
              <div
                className={styles.frame}
                onClick={(e) => { if (!it.removed) props.onClick(it.key, e, window.matchMedia("(hover: none)").matches); }}
              >
                {bmp ? <Thumb bmp={bmp} item={it} /> : <span className={cx(styles.loading, ui.pulse)} />}
                <span className={styles.ck} />
                {!it.removed && (
                  <div className={styles.hov}>
                    <button onClick={(e) => { e.stopPropagation(); props.onRotate(it.key, 270); }} title="Rotate left" aria-label={`Rotate page ${it.from} left`}><Icon name="rotateLeft" size={15} /></button>
                    <button onClick={(e) => { e.stopPropagation(); props.onRotate(it.key, 90); }} title="Rotate right" aria-label={`Rotate page ${it.from} right`}><Icon name="rotateRight" size={15} /></button>
                    <button className={ui.danger} onClick={(e) => { e.stopPropagation(); props.onRemove(it.key); }} title="Remove" aria-label={`Remove page ${it.from}`}><Icon name="trash" size={15} /></button>
                  </div>
                )}
              </div>
              <div className={styles.lbl}>
                <span className={styles.no}>{it.from}</span>
                {it.removed ? (
                  <><span className={cx(styles.badge, styles.badgeRm)}>removed</span><button className={ui.link} onClick={() => props.onRestore(it.key)}>Restore</button></>
                ) : (
                  <>
                    {it.r !== 0 && !(it.m && it.r === 180) && <span className={styles.badge}><Icon name={it.r === 270 ? "rotateLeft" : "rotateRight"} size={11} />{it.r === 180 ? "180°" : "90°"}</span>}
                    {it.m && <span className={styles.badge}><Icon name={it.r === 180 ? "flipV" : "flipH"} size={11} /></span>}
                    {(it.crop || it.s !== 0) && <span className={styles.badge}><Icon name="crop" size={11} /></span>}
                    {!changed && null}
                  </>
                )}
              </div>
            </div>
          );
        })}
        {drag && <div className={cx(styles.dropEnd, drag.before === null && styles.dropEndOn)} />}
      </div>
    </div>
  );
}

/** Draws a page through its pending edit. */
function Thumb({ bmp, item }: { bmp: Bitmap; item: EditItem }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const k = bmp.canvas.width / bmp.w;
    const out = canvasTransform(item, bmp.w, bmp.h, k, 1);
    // Fit the output into the cell; draw at device resolution.
    const css = 148 / Math.max(out.w, out.h);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const k2 = css * dpr;
    const t = canvasTransform(item, bmp.w, bmp.h, k, k2);
    c.width = Math.max(1, Math.round(out.w * k2));
    c.height = Math.max(1, Math.round(out.h * k2));
    c.style.width = `${Math.round(out.w * css)}px`;
    c.style.height = `${Math.round(out.h * css)}px`;
    const ctx = c.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(...t.t);
    ctx.drawImage(bmp.canvas, 0, 0);
  }, [bmp, item.r, item.m, item.s, item.crop]); // eslint-disable-line react-hooks/exhaustive-deps
  return <canvas ref={ref} className={styles.thumb} />;
}

/** Crop and straighten one page: drag the box or its handles, or let Detect edges place it. */
function CropView({ item, pdf, onCancel, onDone }: {
  item: EditItem;
  pdf: PDFDocumentProxy | null;
  onCancel: () => void;
  onDone: (straighten: number, crop: CropBox | null) => void;
}) {
  const { toast } = useAppData();
  const [bmp, setBmp] = useState<Bitmap | null>(null);
  const [s, setS] = useState(item.s);
  const [crop, setCrop] = useState<CropBox>(item.crop ?? { x: 0, y: 0, w: 1, h: 1 });
  const area = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [fit, setFit] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (pdf) renderPage(pdf, item.from, CROP_PX).then((b) => { if (!cancelled) setBmp(b); }, () => {});
    return () => { cancelled = true; };
  }, [pdf, item.from]);

  // The page without its crop, fitted into the area.
  const view = { r: item.r, m: item.m, s, crop: null };
  useEffect(() => {
    const el = area.current;
    if (!el || !bmp) return;
    const ro = new ResizeObserver(() => {
      const o = canvasTransform(view, bmp.w, bmp.h, 1, 1);
      const pad = 28;
      const k = Math.min((el.clientWidth - 2 * pad) / o.w, (el.clientHeight - 2 * pad) / o.h);
      setFit({ w: o.w * k, h: o.h * k });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [bmp, item.r]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const c = canvas.current;
    if (!c || !bmp || !fit) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const k = bmp.canvas.width / bmp.w;
    const o = canvasTransform(view, bmp.w, bmp.h, k, 1);
    const k2 = (fit.w / o.w) * dpr;
    const t = canvasTransform(view, bmp.w, bmp.h, k, k2);
    c.width = Math.round(fit.w * dpr);
    c.height = Math.round(fit.h * dpr);
    const ctx = c.getContext("2d")!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.setTransform(...t.t);
    ctx.drawImage(bmp.canvas, 0, 0);
  }, [bmp, fit, s]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Drags a handle ("nw", "e", ...) or the whole box ("move"). */
  const startDrag = (mode: string, e: ReactPointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!fit) return;
    const sx = e.clientX, sy = e.clientY;
    const c0 = crop;
    const min = 0.04;
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / fit.w;
      const dy = (ev.clientY - sy) / fit.h;
      let { x, y, w, h } = c0;
      if (mode === "move") {
        x = clamp(x + dx, 0, 1 - w);
        y = clamp(y + dy, 0, 1 - h);
      } else {
        if (mode.includes("w")) { const nx = clamp(x + dx, 0, x + w - min); w += x - nx; x = nx; }
        if (mode.includes("e")) w = clamp(w + dx, min, 1 - x);
        if (mode.includes("n")) { const ny = clamp(y + dy, 0, y + h - min); h += y - ny; y = ny; }
        if (mode.includes("s")) h = clamp(h + dy, min, 1 - y);
      }
      setCrop({ x, y, w, h });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const detect = () => {
    const c = canvas.current;
    if (!c) return;
    const k = Math.min(1, 200 / Math.max(c.width, c.height));
    const small = document.createElement("canvas");
    small.width = Math.max(1, Math.round(c.width * k));
    small.height = Math.max(1, Math.round(c.height * k));
    const ctx = small.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(c, 0, 0, small.width, small.height);
    const px = ctx.getImageData(0, 0, small.width, small.height).data;
    const lum = new Uint8Array(small.width * small.height);
    for (let i = 0; i < lum.length; i++) lum[i] = (px[i * 4] * 299 + px[i * 4 + 1] * 587 + px[i * 4 + 2] * 114) / 1000;
    const box = detectEdges(lum, small.width, small.height);
    if (box) setCrop(box);
    else toast("No page edges found. Drag the corners instead.");
  };

  const full = crop.x <= 0.001 && crop.y <= 0.001 && crop.w >= 0.999 && crop.h >= 0.999;
  const done = () => onDone(Math.round(s * 10) / 10, full ? null : crop);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input")) return;
      if (e.key === "Enter") { e.preventDefault(); done(); }
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <>
      <div className={styles.toolbar}>
        <span className={styles.mode}>EDIT PAGES</span>
        <b className={styles.cropTitle}>Crop page {item.from}</b>
        <span className={styles.sep} />
        <button className={ui.compact} onClick={detect} disabled={!bmp}><Icon name="detect" size={15} /> Detect edges</button>
        <button className={cx(ui.compact, ui.ghost)} onClick={() => { setCrop({ x: 0, y: 0, w: 1, h: 1 }); setS(0); }}>Reset</button>
        <span className={styles.sep} />
        <label className={cx(ui.inline, styles.straighten)}>
          Straighten
          <input type="range" min={-15} max={15} step={0.5} value={s} onChange={(e) => setS(Number(e.target.value))} />
          <span className={ui.mono}>{s > 0 ? "+" : ""}{s}°</span>
        </label>
        <span className={ui.spacer} />
        <button className={ui.compact} onClick={onCancel}>Cancel</button>
        <button className={cx(ui.compact, ui.primary)} onClick={done}>Done</button>
      </div>
      <div ref={area} className={styles.cropArea}>
        {!bmp && <p className={cx(styles.message, ui.pulse)}>Loading…</p>}
        {bmp && fit && (
          <div className={styles.cropStage} style={{ width: fit.w, height: fit.h }}>
            <canvas ref={canvas} style={{ width: fit.w, height: fit.h, display: "block" }} />
            <div
              className={styles.cropBox}
              style={{ left: crop.x * fit.w, top: crop.y * fit.h, width: crop.w * fit.w, height: crop.h * fit.h }}
              onPointerDown={(e) => startDrag("move", e)}
            >
              {HANDLES.map(([h, cls]) => (
                <span key={h} className={cx(styles.handle, cls)} onPointerDown={(e) => startDrag(h, e)} />
              ))}
            </div>
          </div>
        )}
        <div className={styles.cropHint}>Drag the box or its corners. <kbd>Enter</kbd> done · <kbd>Esc</kbd> cancel</div>
      </div>
      {/* Phone controls under the page */}
      <div className={styles.pcrop}>
        <label className={cx(ui.inline, styles.straighten)}>
          Straighten
          <input type="range" min={-15} max={15} step={0.5} value={s} onChange={(e) => setS(Number(e.target.value))} />
          <span className={ui.mono}>{s > 0 ? "+" : ""}{s}°</span>
        </label>
        <div className={styles.pcropRow}>
          <button onClick={detect} disabled={!bmp}><Icon name="detect" size={16} /> Detect edges</button>
          <button className={ui.ghost} onClick={() => { setCrop({ x: 0, y: 0, w: 1, h: 1 }); setS(0); }}>Reset</button>
          <span className={ui.spacer} />
          <button onClick={onCancel}>Cancel</button>
          <button className={ui.primary} onClick={done}>Done</button>
        </div>
      </div>
    </>
  );
}

const HANDLES: Array<[string, string]> = [
  ["nw", styles.h_nw], ["n", styles.h_n], ["ne", styles.h_ne], ["e", styles.h_e],
  ["se", styles.h_se], ["s", styles.h_s], ["sw", styles.h_sw], ["w", styles.h_w],
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

async function renderPage(d: PDFDocumentProxy, n: number, maxPx: number): Promise<Bitmap> {
  const page = await d.getPage(n);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = maxPx / Math.max(vp1.width, vp1.height);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  await page.render({ canvas, viewport: vp }).promise;
  return { canvas, w: vp1.width, h: vp1.height };
}
