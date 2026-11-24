// Types shared by the server and the web UI (the web imports this file directly).

export const FIELD_TYPES = ["text", "longtext", "number", "money", "date", "boolean", "select", "ref"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface FieldOptions {
  /** select: allowed values */
  choices?: string[];
  /** money: ISO currency code shown next to the amount */
  currency?: string;
  /** ref: if set, the target object must carry this component key */
  component?: string;
  /**
   * text/number: the value identifies one thing (VIN, licence plate, account or
   * policy number). Objects with the same component and identifier value are
   * the same object, which is how duplicates are caught.
   */
  identifier?: boolean;
}

export interface FieldDef {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  description: string;
  required: boolean;
  options: FieldOptions;
  position: number;
}

export interface ComponentDef {
  id: string;
  key: string;
  name: string;
  description: string;
  aiHint: string;
  color: string;
  fields: FieldDef[];
  usage?: number;
  /** How many documents (outside the trash) carry it. */
  documentUsage?: number;
}

/** Input shape for creating/updating a component definition. Fields with an id are updated in place. */
export interface ComponentInput {
  key: string;
  name: string;
  description: string;
  aiHint: string;
  color?: string;
  fields: Array<Omit<FieldDef, "id" | "position"> & { id?: string }>;
}

/**
 * A field value inside a draft.
 * - number / money: number
 * - boolean: boolean
 * - date: "YYYY-MM-DD"
 * - ref: an existing entity id, or "new:<tempId>" pointing at an object in `Draft.newObjects`
 * - everything else: string
 */
export type DraftValue = string | number | boolean | null;

export interface DraftComponent {
  /** component key; may name an entry in `Draft.newComponents` */
  component: string;
  /** field key -> value */
  values: Record<string, DraftValue>;
}

export interface DraftNewObject {
  tempId: string;
  title: string;
  components: DraftComponent[];
}

/**
 * The editable description of an entity's metadata. The AI produces one as its
 * proposal; the UI edits it; applying it writes everything in one transaction.
 */
export interface Draft {
  title: string;
  documentDate: string | null;
  components: DraftComponent[];
  /** Component definitions to create when the draft is applied. */
  newComponents: ComponentInput[];
  /** Objects (cars, houses, ...) to create when the draft is applied. */
  newObjects: DraftNewObject[];
  /**
   * Values to set on existing objects when the draft is applied, e.g. a
   * licence plate learned from this document. Only the listed fields change.
   */
  objectUpdates?: DraftObjectUpdate[];
  /**
   * Changes to existing component definitions, made when the draft is
   * applied. Only changes that can't lose data: a field's required flag, and
   * new fields. The owner asks for these when revising a proposal.
   */
  componentChanges?: DraftComponentChange[];
}

export interface DraftComponentChange {
  /** Key of an existing component. */
  component: string;
  /** Field key -> new required flag. */
  required?: Record<string, boolean>;
  /** Fields to add at the end. */
  addFields?: ComponentInput["fields"];
}

export interface DraftObjectUpdate {
  objectId: string;
  components: DraftComponent[];
}

export interface Proposal {
  draft: Draft;
  reasoning: string;
  model: string;
  createdAt: string;
  /** Issues found while validating the model's output (dropped values etc.). */
  warnings: string[];
  /** Change requests the owner made, oldest first; each revision saw all of them. */
  feedback?: string[];
  /** Proposed new objects that turned out to be existing ones, and why. */
  matched?: string[];
}

export type DocumentStatus = "queued" | "ocr" | "analyzing" | "inbox" | "filed" | "failed" | "trashed";

export interface DocumentSummary {
  id: string;
  title: string;
  status: DocumentStatus;
  originalFilename: string;
  mimeType: string;
  documentDate: string | null;
  addedAt: string;
  pageCount: number | null;
  hasThumb: boolean;
  components: string[];
  snippet?: string;
  /** Why a text search matched: the words, the meaning (embeddings), or both. */
  match?: "text" | "meaning" | "both";
  error: string | null;
  /** How many uploads the document was merged from; null if it wasn't merged. */
  parts?: number | null;
  /** For a document in the trash because it was merged into another: that document's title. */
  mergedInto?: string | null;
  /** For inbox documents with an AI proposal: what the proposal would file it as. */
  proposed?: { title: string; documentDate: string | null; components: string[]; draft: Draft };
  /** The document's components with their values; only when asked for (`values=1`). */
  values?: DraftComponent[];
}

export interface DocumentDetail extends DocumentSummary {
  content: string;
  fileSize: number;
  hasArchive: boolean;
  /** The pages were edited (rotated, cropped, removed...); "Revert to original" undoes it. */
  pagesEdited: boolean;
  /** Changes whenever the searchable PDF is rewritten, so viewers reload it. */
  fileVersion: string;
  current: Draft;
  proposal: Proposal | null;
  /** The uploads a merged document is made of, in page order. Null if it wasn't merged. */
  mergeParts: Array<{ id: string; filename: string; pages: number }> | null;
  /** How many documents undoing its latest merge would give back (0 if it can't be undone: never merged, or the others left the trash). */
  splitsInto: number;
}

/** One upload of a merged document. */
export interface MergePart {
  /** The document it came in as (in the trash once merged, and gone once purged; the file is kept). */
  id: string;
  filename: string;
  mimeType: string;
  /** Relative to the data directory. */
  originalPath: string;
  /** Its pages at the time of the merge. */
  pages: number;
}

export interface ObjectSummary {
  id: string;
  title: string;
  notes: string;
  components: string[];
  /** short "Vehicle: Honda Civic 2019" style description for pickers and the AI */
  summary: string;
  documentCount: number;
}

export interface ObjectDetail extends ObjectSummary {
  current: Draft;
  /** Other objects whose fields link to this one (a policy covering this car, say). */
  linkedFrom: Array<{ id: string; title: string }>;
  /** The document each detail came from, for details set by filing a document and unchanged since. */
  sources: Array<{ component: string; field: string; documentId: string; documentTitle: string; setAt: string }>;
}

export interface AggregateSpec {
  fn: "count" | "sum" | "avg" | "min" | "max";
  /** For anything but count: a number or money field. */
  component?: string;
  field?: string;
  groupBy: "none" | "year" | "month" | "object";
}

export interface AggregateResult {
  label: string;
  /** Currency for money fields. */
  unit: string | null;
  groupBy: AggregateSpec["groupBy"];
  rows: Array<{ group: string | null; value: number | null; documents: number }>;
}

/** The structured search an AI-interpreted question turned into. */
export interface InterpretedSearch {
  q: string | null;
  components: string[];
  where: string[];
  ref: string | null;
  from: string | null;
  to: string | null;
  sort: "relevance" | "date" | "added" | "title";
  aggregate: AggregateSpec | null;
  explanation: string;
  /** Parts of the model's answer that didn't check out and were dropped. */
  warnings: string[];
}

export interface AskResponse {
  answer: string;
  /** Documents the answer cites, in order of first citation. */
  citations: Array<{ id: string; title: string; documentDate: string | null }>;
  /** What the assistant looked up, for transparency. */
  steps: string[];
}

/** Where a crop sits on a page, as fractions of its width and height, measured from the top left. */
export interface CropBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * One page of the edited document: which current page it comes from and what
 * to do to it, applied in this order: rotate, flip, straighten, crop.
 */
export interface PageOp {
  /** 1-based page number in the document as it is now. */
  from: number;
  /** Clockwise. */
  rotate?: 0 | 90 | 180 | 270;
  /** Mirror left to right. */
  flipH?: boolean;
  /** Mirror top to bottom. */
  flipV?: boolean;
  /** Small clockwise turn in degrees, for crooked scans. */
  straighten?: number;
  crop?: CropBox | null;
}
