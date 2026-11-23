import { useRef, useState } from "react";
import { api } from "../api";
import { cx } from "../cx";
import { useAppData } from "../data";
import ui from "../ui.module.css";
import styles from "./SemanticStatus.module.css";

const plural = (n: number, word: string) => `${n} document${n === 1 ? "" : "s"} ${word}`;

/**
 * A top-bar chip that shows when search by meaning isn't working or is still
 * catching up, so embedding problems don't go unnoticed. Hidden when
 * everything is embedded, and when semantic search isn't configured at all.
 */
export function SemanticStatus() {
  const { status, refresh, toast } = useAppData();
  const menu = useRef<HTMLDetailsElement>(null);
  const [busy, setBusy] = useState(false);
  const s = status?.semantic;
  if (!s?.configured) return null;

  const off = !s.available;
  const stalled = s.available && !!s.lastError;
  if (!off && !stalled && s.pending === 0) return null;

  const label = off ? "Meaning search off" : stalled ? "Indexing stalled" : `Indexing ${s.pending}…`;

  const retry = async () => {
    setBusy(true);
    try {
      const r = await api.retrySemantic();
      await refresh();
      if (!r.available) toast(`Still can't turn on search by meaning: ${r.reason}`, "error");
      else if (r.pending) toast(`Search by meaning is on. Indexing ${plural(r.pending, "in the background.")}`);
      else toast("Search by meaning is on.");
      menu.current?.removeAttribute("open");
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className={cx(ui.menuWrap, styles.wrap)} ref={menu}>
      <summary className={cx(styles.chip, (off || stalled) && styles.chipWarn)} title={off ? s.reason : undefined}>
        {label}
      </summary>
      <div className={cx(ui.menu, styles.panel)}>
        {off ? (
          <>
            <strong>Search by meaning is off</strong>
            <p>{s.reason}</p>
            {s.pending > 0 && <p>{plural(s.pending, "will be indexed once it's back. Keyword search still works.")}</p>}
            {s.retrying && <p className={ui.muted}>Docket keeps retrying on its own.</p>}
          </>
        ) : (
          <>
            <strong>{stalled ? "Indexing for search by meaning is failing" : "Indexing for search by meaning"}</strong>
            {stalled && <p>{s.lastError}</p>}
            {s.pending > 0 && <p>{plural(s.pending, `left to embed with ${s.model}. Until then they're found by keywords only.`)}</p>}
          </>
        )}
        {(s.retrying || stalled) && (
          <div className={styles.actions}>
            <button className={ui.primary} disabled={busy} onClick={() => void retry()}>
              {busy ? "Checking…" : "Retry now"}
            </button>
          </div>
        )}
      </div>
    </details>
  );
}
