import { useEffect, useMemo, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { fileUrl } from "../api";
import { cx } from "../cx";
import ui from "../ui.module.css";
import { Icon } from "./Icon";
import styles from "./MergeView.module.css";
import type { MergeDoc, MergePageRef } from "./mergeGap";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type Thumb = { url: string; w: number; h: number };

/** Points to CSS pixels for the page strip, so a receipt looks receipt-sized next to a letter page. */
const STRIP_SCALE = 0.34;
const PHONE_SCALE = 0.22;
const TONES = ["a", "b", "c", "d"] as const;
const TONE_CLASS = { a: styles.tone_a, b: styles.tone_b, c: styles.tone_c, d: styles.tone_d };
const TAG_CLASS = { a: styles.tag_a, b: styles.tag_b, c: styles.tag_c, d: styles.tag_d };

const scanOrder = (docs: MergeDoc[]): MergePageRef[] =>
  [...docs].sort((a, b) => a.addedAt.localeCompare(b.addedAt)).flatMap((d) => Array.from({ length: d.pageCount }, (_, i) => ({ id: d.id, page: i + 1 })));
const key = (p: MergePageRef) => `${p.id}:${p.page}`;

/**
 * Merge with…: pick other inbox documents, put their pages in order, and
 * merge them into `into`. Pages start in scan order. Pages are dragged on a
 * computer, or selected and moved with the arrows (or ← →) anywhere. On a
 * phone it's two full-screen steps: pick, then order. This module pulls in
 * PDF.js; load it lazily.
 */
export default function MergeView(props: {
  into: string;
  /** Every inbox document that can take part, including `into`, nearest scan time first. */
  docs: MergeDoc[];
  /** Ticked to begin with. */
  initial: string[];
  /** Why a document is near the top of the list ("1 min later · same amount"); `strong` when it's a likely match. */
  reason: (id: string) => { text: string; strong: boolean };
  ai: boolean;
  busy: boolean;
  onCancel: () => void;
  onMerge: (pages: MergePageRef[]) => void;
}) {
  const { into, docs } = props;
  const byId = useMemo(() => new Map(docs.map((d) => [d.id, d])), [docs]);
  const [picked, setPicked] = useState<string[]>(() => props.initial.filter((id) => id !== into && byId.has(id)));
  const members = useMemo(() => [into, ...picked].map((id) => byId.get(id)).filter((d): d is MergeDoc => !!d), [into, picked, byId]);
  const [pages, setPages] = useState<MergePageRef[]>(() => scanOrder(members));
  const [custom, setCustom] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ from: string; over: number | null } | null>(null);
  const [step, setStep] = useState<"pick" | "order">("pick");
  const [thumbs, setThumbs] = useState<Map<string, Thumb[]>>(new Map());
  const loading = useRef(new Set<string>());

  // Keep the order in step with what's ticked: scan order until the owner moves something.
  useEffect(() => {
    setPages((cur) => {
      if (!custom) return scanOrder(members);
      const ids = new Set(members.map((d) => d.id));
      const kept = cur.filter((p) => ids.has(p.id));
      const have = new Set(kept.map((p) => p.id));
      return [...kept, ...scanOrder(members.filter((d) => !have.has(d.id)))];
    });
  }, [members]); // eslint-disable-line react-hooks/exhaustive-deps

  // Render small images of each member's pages, once.
  useEffect(() => {
    for (const d of members) {
      if (loading.current.has(d.id)) continue;
      loading.current.add(d.id);
      void (async () => {
        try {
          const task = pdfjs.getDocument({ url: fileUrl(d.id, "archive") });
          const pdf = await task.promise;
          const out: Thumb[] = [];
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const vp1 = page.getViewport({ scale: 1 });
            const vp = page.getViewport({ scale: 320 / Math.max(vp1.width, vp1.height) });
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(vp.width);
            canvas.height = Math.round(vp.height);
            await page.render({ canvas, viewport: vp }).promise;
            out.push({ url: canvas.toDataURL("image/jpeg", 0.85), w: vp1.width, h: vp1.height });
            setThumbs((m) => new Map(m).set(d.id, [...out]));
          }
          void task.destroy();
        } catch { /* the tile shows a blank page */ }
      })();
    }
  }, [members]);

  /** Documents in the order their first page appears, each with its letter and colour. */
  const legend = useMemo(() => {
    const seen: string[] = [];
    for (const p of pages) if (!seen.includes(p.id) && byId.has(p.id)) seen.push(p.id);
    return seen.map((id, i) => ({ id, letter: String.fromCharCode(65 + i), tone: TONES[i % TONES.length], doc: byId.get(id)! }));
  }, [pages, byId]);
  const tag = (id: string) => legend.find((l) => l.id === id);

  const reorder = (next: MergePageRef[]) => { setPages(next); setCustom(true); };
  const moveTo = (k: string, index: number) => {
    const from = pages.findIndex((p) => key(p) === k);
    if (from < 0) return;
    const next = [...pages];
    const [p] = next.splice(from, 1);
    next.splice(index > from ? index - 1 : index, 0, p);
    reorder(next);
  };
  const nudge = (k: string, dir: -1 | 1) => {
    const i = pages.findIndex((p) => key(p) === k);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= pages.length) return;
    const next = [...pages];
    [next[i], next[j]] = [next[j], next[i]];
    reorder(next);
  };
  /** Moves a whole document up or down the order; its pages stay together. */
  const moveDoc = (id: string, dir: -1 | 1) => {
    const ids = legend.map((l) => l.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorder(ids.flatMap((x) => pages.filter((p) => p.id === x)));
  };
  const toggle = (id: string) => setPicked((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const keysRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keysRef.current = (e) => {
    const t = e.target as HTMLElement | null;
    if (t && ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
    if (e.key === "Escape") { e.preventDefault(); props.onCancel(); }
    else if (sel && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { e.preventDefault(); nudge(sel, e.key === "ArrowLeft" ? -1 : 1); }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keysRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const target = byId.get(into)!;
  const others = docs.filter((d) => d.id !== into);
  const leaving = members.filter((d) => d.id !== into);
  const canMerge = leaving.length > 0 && !props.busy;
  const merge = () => { if (canMerge) props.onMerge(pages); };
  const selIndex = sel ? pages.findIndex((p) => key(p) === sel) : -1;

  const tile = (p: MergePageRef, i: number, scale: number) => {
    const k = key(p);
    if (!tag(p.id)) return null;
    const t = thumbs.get(p.id)?.[p.page - 1];
    const l = tag(p.id)!;
    const w = (t?.w ?? 612) * scale;
    const h = (t?.h ?? 792) * scale;
    return (
      <div
        key={k}
        className={cx(styles.tile, TONE_CLASS[l.tone], sel === k && styles.tileSel, drag?.from === k && styles.dragging, drag?.over === i && drag.from !== k && styles.dropBefore)}
        draggable
        onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", k); setDrag({ from: k, over: null }); }}
        onDragOver={(e) => {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          const over = e.clientX < r.left + r.width / 2 ? i : i + 1;
          if (drag && drag.over !== over) setDrag({ ...drag, over });
        }}
        onDrop={(e) => { e.preventDefault(); if (drag?.over != null) moveTo(drag.from, drag.over); setDrag(null); }}
        onDragEnd={() => setDrag(null)}
        onClick={() => setSel(sel === k ? null : k)}
      >
        <div className={styles.frame}>
          {t ? <img src={t.url} alt="" style={{ width: w, height: h }} draggable={false} /> : <div className={styles.blank} style={{ width: w, height: h }} />}
        </div>
        <div className={styles.cap}>
          <b>{i + 1}</b>
          <span className={cx(styles.tag, TAG_CLASS[l.tone])}>{l.letter}{l.doc.pageCount > 1 ? ` · p${p.page}` : ""}</span>
        </div>
        {sel === k && (
          <div className={styles.moveBar} onClick={(e) => e.stopPropagation()}>
            <button className={ui.compact} aria-label="Move earlier" disabled={i === 0} onClick={() => nudge(k, -1)}>◀</button>
            <button className={ui.compact} aria-label="Move later" disabled={i === pages.length - 1} onClick={() => nudge(k, 1)}>▶</button>
          </div>
        )}
      </div>
    );
  };

  return (
    <section className={cx(styles.view, step === "order" ? styles.stepOrder : styles.stepPick)} aria-label="Merge documents">
      {/* phone header */}
      <div className={styles.phead}>
        {step === "pick"
          ? <button className={ui.ghost} onClick={props.onCancel}>Cancel</button>
          : <button className={ui.ghost} onClick={() => setStep("pick")} aria-label="Back"><Icon name="back" size={16} /></button>}
        <span className={styles.ptitle}>{step === "pick" ? "Merge with…" : "Order pages"}</span>
        {step === "pick"
          ? <button className={ui.primary} disabled={!leaving.length} onClick={() => setStep("order")}>Next</button>
          : <button className={ui.primary} disabled={!canMerge} onClick={merge}>Merge</button>}
      </div>

      <div className={styles.strip}>
        <div className={styles.stripBar}>
          <span className={styles.mode}>MERGE</span>
          <b>{pages.length} page{pages.length === 1 ? "" : "s"} from {members.length} document{members.length === 1 ? "" : "s"}</b>
          <span className={ui.spacer} />
          <span className={cx(ui.small, ui.muted, styles.hint)}>{sel ? "← → or the arrows move the selected page" : "Drag pages to reorder, or select one to move it"}</span>
          <span className={styles.legendPhone}>
            {legend.map((l) => <span key={l.id} className={cx(styles.tag, TAG_CLASS[l.tone])}>{l.letter}</span>)}
            <button className={cx(ui.link, ui.small)} disabled={!custom} onClick={() => { setPages(scanOrder(members)); setCustom(false); }}>Scan order</button>
          </span>
        </div>
        <div
          className={styles.tiles}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); if (drag) moveTo(drag.from, drag.over ?? pages.length); setDrag(null); }}
          onClick={(e) => { if (e.target === e.currentTarget) setSel(null); }}
        >
          {pages.map((p, i) => tile(p, i, window.matchMedia?.("(max-width: 700px)").matches ? PHONE_SCALE : STRIP_SCALE))}
        </div>
        {leaving.length === 0 && <p className={cx(ui.muted, styles.emptyNote)}>Tick another document to merge into this one.</p>}
        {selIndex >= 0 && (
          <div className={styles.pmove}>
            <button disabled={selIndex === 0} onClick={() => nudge(sel!, -1)}>◀ Earlier</button>
            <span className={ui.small}>Page {selIndex + 1}</span>
            <button disabled={selIndex === pages.length - 1} onClick={() => nudge(sel!, 1)}>Later ▶</button>
          </div>
        )}
      </div>

      <div className={styles.panel}>
        <div className={styles.panelBody}>
          <div className={styles.head}>
            <h3>Merge with…</h3>
            <span className={ui.spacer} />
            <button className={cx(ui.ghost, ui.compact)} onClick={props.onCancel}>Cancel</button>
          </div>
          <div className={cx(ui.small, ui.muted, styles.into)}>Into <b>{target.title}</b> · {target.pageCount} page{target.pageCount === 1 ? "" : "s"}</div>

          <div className={styles.pickBlock}>
          <div className={styles.section}>Other inbox documents</div>
          {others.length ? (
            <div className={styles.box}>
              {others.map((d) => {
                const on = picked.includes(d.id);
                const r = props.reason(d.id);
                return (
                  <label key={d.id} className={cx(styles.cand, on && styles.candOn)}>
                    <input type="checkbox" checked={on} onChange={() => toggle(d.id)} />
                    <img className={styles.candThumb} src={`/api/documents/${d.id}/thumb`} alt="" loading="lazy" />
                    <span className={styles.candText}>
                      <span className={styles.candTitle}>{d.title}</span>
                      <span className={cx(ui.small, r.strong ? styles.why : ui.muted)}>{r.text}</span>
                      <span className={cx(ui.small, ui.muted)}>{d.pageCount} page{d.pageCount === 1 ? "" : "s"}{d.sub ? ` · ${d.sub}` : ""}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          ) : <p className={cx(ui.small, ui.muted)}>No other documents in the inbox are ready to merge. Documents can be merged once they've been read.</p>}
          </div>

          {members.length > 1 && (
            <div className={styles.orderBlock}>
              <div className={styles.section}>
                Order <span className={ui.spacer} />
                <button className={cx(ui.link, ui.small)} disabled={!custom} onClick={() => { setPages(scanOrder(members)); setCustom(false); }}>Scan order</button>
              </div>
              <div className={styles.box}>
                {legend.map((l, i) => {
                  const nums = pages.map((p, n) => (p.id === l.id ? n + 1 : 0)).filter(Boolean);
                  const contiguous = nums.every((n, j) => j === 0 || n === nums[j - 1] + 1);
                  return (
                    <div key={l.id} className={styles.orderRow}>
                      <span className={cx(styles.tag, TAG_CLASS[l.tone])}>{l.letter}</span>
                      <span className={styles.orderTitle}>{l.doc.title}</span>
                      <span className={cx(ui.small, ui.muted)}>{nums.length === 1 ? `page ${nums[0]}` : contiguous ? `pages ${nums[0]}–${nums[nums.length - 1]}` : `pages ${nums.join(", ")}`}</span>
                      <button className={cx(ui.icon, ui.compact)} aria-label="Move up" disabled={i === 0} onClick={() => moveDoc(l.id, -1)}><Icon name="up" size={14} /></button>
                      <button className={cx(ui.icon, ui.compact)} aria-label="Move down" disabled={i === legend.length - 1} onClick={() => moveDoc(l.id, 1)}><Icon name="down" size={14} /></button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {leaving.length > 0 && (
            <div className={styles.effects}>
              <div className={styles.section}>When you merge</div>
              <ul>
                <li><Icon name="documents" size={15} /><span>One document, {pages.length} pages, titled “{target.title}” until the AI proposes a title</span></li>
                <li><Icon name="trash" size={15} /><span>{leaving.length === 1 ? <>“{leaving[0].title}” goes</> : <>{leaving.length} documents go</>} to the trash as merged. Undo brings {leaving.length === 1 ? "it" : "them"} back.</span></li>
                <li><Icon name="lock" size={15} /><span>The original uploads are kept, unchanged</span></li>
                <li><Icon name="detect" size={15} /><span>{props.ai ? "The AI reads the merged document again. No new OCR." : "Its text and search are updated. No new OCR."}</span></li>
              </ul>
            </div>
          )}
        </div>
        <div className={styles.foot}>
          <button className={ui.primary} disabled={!canMerge} onClick={merge}>
            <Icon name="merge" size={15} /> {props.busy ? "Merging…" : `Merge ${members.length} documents`}
          </button>
          <button onClick={props.onCancel}>Cancel</button>
          <span className={ui.spacer} />
          <span className={cx(ui.small, ui.muted, styles.hint)}><kbd>Esc</kbd> cancel</span>
          <span className={styles.countPhone}>{leaving.length} selected · {pages.length} pages in all</span>
          <button className={cx(ui.primary, styles.nextPhone)} disabled={!leaving.length} onClick={() => setStep("order")}>Next: order</button>
        </div>
      </div>
    </section>
  );
}
