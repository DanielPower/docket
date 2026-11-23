import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";

/**
 * A small, upload-only FTP server, so a scanner can send scans straight to
 * Docket. Unlike a watched folder, Docket knows exactly when a scan is
 * complete: the scanner closes the data connection at the end of the file.
 * The scanner hears "226" only after the document is in the inbox, so a
 * failure shows up on the scanner instead of being lost.
 *
 * Nothing touches the file system: directories are pretend (CWD and MKD
 * always succeed, listings are empty), and each upload is kept in memory and
 * handed to `onFile`. It speaks just enough FTP for scanners and common
 * clients: passive (PASV, EPSV) and active (PORT, EPRT) transfers, binary
 * and ASCII types (both stored as sent). There is no TLS, so keep it on the
 * home network.
 */
export interface FtpOptions {
  port: number;
  host: string;
  user: string;
  password: string;
  /** Address given out in PASV replies. Defaults to the address the client connected to, which is wrong behind Docker's port mapping. */
  pasvAddress?: string;
  /** Ports for passive data connections, inclusive. Publish the same range from the container. */
  pasvPorts: [number, number];
  /** Largest upload accepted, in bytes. */
  maxBytes: number;
  /** Stores an upload; resolves with a short note for the log, or throws to make the scanner report a failure. */
  onFile: (data: Buffer, filename: string) => Promise<string>;
  log: (msg: string) => void;
}

const IDLE_MS = 5 * 60_000;
const DATA_WAIT_MS = 30_000;
const MAX_FAILED_LOGINS = 3;

/** "::ffff:192.168.0.5" -> "192.168.0.5" */
const plainIp = (a: string | undefined) => (a ?? "").replace(/^::ffff:/, "");

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

type DataPlan =
  | { kind: "passive"; server: net.Server; socket: Promise<net.Socket> }
  | { kind: "active"; host: string; port: number };

export function startFtpServer(o: FtpOptions): Promise<net.Server> {
  const server = net.createServer((socket) => session(socket, o));
  server.on("error", (err) => o.log(`FTP server error: ${err.message}`));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function session(ctl: net.Socket, o: FtpOptions) {
  const peer = plainIp(ctl.remoteAddress);
  let user: string | null = null;
  let authed = false;
  let failed = 0;
  let cwd = "/";
  let data: DataPlan | null = null;
  let closed = false;

  ctl.setEncoding("utf8");
  ctl.setTimeout(IDLE_MS, () => { reply(421, "Idle too long, closing."); ctl.end(); });
  ctl.on("error", () => {});
  ctl.on("close", () => { closed = true; dropData(); });

  const reply = (code: number, text: string) => {
    if (closed) return;
    // Multi-line: "211-first", then the middle lines as they are (FEAT wants " EPSV"), then "211 last".
    const lines = text.split("\n");
    const last = lines.pop()!;
    const head = lines.map((l, i) => (i === 0 ? `${code}-${l}` : l) + "\r\n").join("");
    ctl.write(`${head}${code} ${last}\r\n`);
  };

  function dropData() {
    if (data?.kind === "passive") data.server.close();
    data = null;
  }

  /** Opens a passive listener on a free port from the range; only the control connection's own address may connect. */
  async function openPassive(): Promise<number> {
    dropData();
    const [lo, hi] = o.pasvPorts;
    const ports = lo === 0 ? [0] : Array.from({ length: hi - lo + 1 }, (_, i) => lo + i).sort(() => Math.random() - 0.5);
    for (const port of ports) {
      const srv = net.createServer();
      const ok = await new Promise<boolean>((res) => {
        srv.once("error", () => res(false));
        srv.listen(port, o.host, () => res(true));
      });
      if (!ok) continue;
      const socket = new Promise<net.Socket>((resolve, reject) => {
        const timer = setTimeout(() => { srv.close(); reject(new Error("no data connection")); }, DATA_WAIT_MS);
        srv.on("connection", (s) => {
          // Refuse anyone but the client on this control connection (no data hijacking).
          if (plainIp(s.remoteAddress) !== peer) { s.destroy(); return; }
          clearTimeout(timer);
          srv.close();
          resolve(s);
        });
      });
      socket.catch(() => {});
      data = { kind: "passive", server: srv, socket };
      return (srv.address() as net.AddressInfo).port;
    }
    throw new Error("no free passive port");
  }

  /** The data connection for the current command; the plan is used once. */
  async function dataSocket(): Promise<net.Socket> {
    const plan = data;
    data = null;
    if (!plan) throw new Error("Use PASV, EPSV, PORT or EPRT first.");
    if (plan.kind === "passive") return plan.socket;
    return new Promise((resolve, reject) => {
      const s = net.connect(plan.port, plan.host);
      s.setTimeout(DATA_WAIT_MS, () => { s.destroy(); reject(new Error("timed out connecting")); });
      s.once("connect", () => { s.setTimeout(0); resolve(s); });
      s.once("error", reject);
    });
  }

  /** Receives one file over the data connection. Resolves only when the client closed it cleanly, i.e. the file is complete. */
  function receive(s: net.Socket): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let ended = false;
      s.setTimeout(IDLE_MS, () => s.destroy(new Error("transfer stalled")));
      s.on("data", (c: Buffer) => {
        size += c.length;
        if (size > o.maxBytes) { s.destroy(new Error(`larger than ${Math.round(o.maxBytes / 1024 / 1024)} MB`)); return; }
        chunks.push(c);
      });
      s.on("end", () => { ended = true; s.end(); });
      s.on("error", (err) => reject(err));
      s.on("close", () => (ended ? resolve(Buffer.concat(chunks, size)) : reject(new Error("connection closed before the end of the file"))));
    });
  }

  async function sendListing(): Promise<void> {
    let s: net.Socket;
    try { s = await dataSocket(); } catch (e) { reply(425, (e as Error).message); return; }
    reply(150, "Here comes the listing.");
    s.end();
    reply(226, "Done (uploads aren't kept as files here).");
  }

  async function store(name: string) {
    const filename = path.posix.basename(name.replace(/\\/g, "/")) || `scan-${Date.now()}.pdf`;
    let s: net.Socket;
    try { s = await dataSocket(); } catch (e) { reply(425, (e as Error).message); return; }
    reply(150, `Ready for ${filename}.`);
    let buf: Buffer;
    try {
      buf = await receive(s);
    } catch (e) {
      o.log(`FTP upload of ${filename} from ${peer} failed: ${(e as Error).message}`);
      reply(426, `Transfer aborted: ${(e as Error).message}`);
      return;
    }
    // Some scanners test the connection by uploading an empty file.
    if (buf.length === 0) { reply(226, "Empty file ignored."); return; }
    try {
      const note = await o.onFile(buf, filename);
      o.log(`FTP: received ${filename} (${buf.length} bytes) from ${peer} -> ${note}`);
      reply(226, "Received; it's in the Docket inbox.");
    } catch (e) {
      o.log(`FTP: could not take ${filename} from ${peer}: ${(e as Error).message}`);
      reply(451, `Not added: ${(e as Error).message}`);
    }
  }

  const resolvePath = (p: string) => path.posix.resolve(cwd, p || ".");

  async function handle(line: string) {
    const sp = line.indexOf(" ");
    const cmd = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
    const arg = sp < 0 ? "" : line.slice(sp + 1);

    switch (cmd) {
      case "USER":
        user = arg;
        authed = false;
        return reply(331, "Password, please.");
      case "PASS": {
        if (user !== null && safeEqual(user, o.user) && safeEqual(arg, o.password)) {
          authed = true;
          return reply(230, "Logged in. Send scans with STOR.");
        }
        failed++;
        o.log(`FTP: failed login from ${peer}${user ? ` as ${JSON.stringify(user)}` : ""}`);
        // Slow down guessing, and hang up after a few tries.
        await new Promise((r) => setTimeout(r, 1000));
        reply(530, "Wrong user name or password.");
        if (failed >= MAX_FAILED_LOGINS) ctl.end();
        return;
      }
      case "QUIT":
        reply(221, "Bye.");
        ctl.end();
        return;
      case "NOOP": return reply(200, "OK.");
      case "SYST": return reply(215, "UNIX Type: L8");
      case "FEAT": return reply(211, "Features:\n EPSV\n PASV\n UTF8\nEnd");
      case "OPTS": return reply(200, "OK.");
      case "CLNT": return reply(200, "OK.");
      case "HELP": return reply(214, "Docket receives scans: log in, then STOR each file.");
      case "AUTH": return reply(502, "TLS isn't supported; use this on the home network only.");
    }

    if (!authed) return reply(530, "Log in first.");

    switch (cmd) {
      case "PWD":
      case "XPWD": return reply(257, `"${cwd}" is the current folder.`);
      case "CWD":
      case "XCWD": cwd = resolvePath(arg); return reply(250, "OK.");
      case "CDUP":
      case "XCUP": cwd = resolvePath(".."); return reply(250, "OK.");
      case "MKD":
      case "XMKD": return reply(257, `"${resolvePath(arg)}" created.`);
      case "RMD":
      case "XRMD":
      case "DELE": return reply(250, "OK.");
      case "TYPE": return /^[AI]/i.test(arg) ? reply(200, "OK.") : reply(504, "Only types A and I.");
      case "MODE": return /^S$/i.test(arg) ? reply(200, "OK.") : reply(504, "Only stream mode.");
      case "STRU": return /^F$/i.test(arg) ? reply(200, "OK.") : reply(504, "Only file structure.");
      case "ALLO": return reply(202, "No need.");
      case "SITE": return reply(202, "Nothing to do.");
      case "REST": return arg.trim() === "0" ? reply(350, "OK.") : reply(502, "Resuming isn't supported.");
      case "SIZE":
      case "MDTM": return reply(550, "No such file.");
      case "RNFR": return reply(350, "OK.");
      case "RNTO": return reply(250, "OK.");
      case "ABOR": dropData(); return reply(226, "OK.");
      case "PASV": {
        const addr = o.pasvAddress ?? plainIp(ctl.localAddress);
        if (!net.isIPv4(addr)) return reply(425, "Use EPSV, or set FTP_PASV_ADDRESS.");
        try {
          const port = await openPassive();
          return reply(227, `Entering Passive Mode (${addr.replace(/\./g, ",")},${port >> 8},${port & 255}).`);
        } catch (e) { return reply(425, (e as Error).message); }
      }
      case "EPSV": {
        if (/^ALL$/i.test(arg)) return reply(200, "OK.");
        try {
          const port = await openPassive();
          return reply(229, `Entering Extended Passive Mode (|||${port}|).`);
        } catch (e) { return reply(425, (e as Error).message); }
      }
      case "PORT":
      case "EPRT": {
        let host: string, port: number;
        if (cmd === "PORT") {
          const n = arg.split(",").map(Number);
          if (n.length !== 6 || n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return reply(501, "Bad PORT.");
          host = n.slice(0, 4).join(".");
          port = n[4] * 256 + n[5];
        } else {
          const parts = arg.split(arg[0] ?? "|");
          host = parts[2] ?? "";
          port = Number(parts[3]);
        }
        // Only connect back to the client itself, never a third host (FTP bounce).
        if (plainIp(host) !== peer || !(port > 0 && port < 65536)) return reply(504, "Data connections go to your own address only.");
        dropData();
        data = { kind: "active", host: plainIp(host), port };
        return reply(200, "OK.");
      }
      case "LIST":
      case "NLST":
      case "MLSD": return sendListing();
      case "STOR":
      case "APPE": return store(arg);
      case "STOU": return store(`scan-${Date.now()}.pdf`);
      case "RETR": dropData(); return reply(550, "Docket only receives files.");
      default: return reply(502, `${cmd} isn't supported.`);
    }
  }

  // Commands run one at a time, in order; an upload finishes before the next command.
  let queue = Promise.resolve();
  let pending = "";
  ctl.on("data", (chunk: string) => {
    pending += chunk;
    if (pending.length > 8192) { ctl.destroy(); return; }
    let nl: number;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl).replace(/\r$/, "");
      pending = pending.slice(nl + 1);
      if (!line) continue;
      queue = queue.then(() => handle(line)).catch((e) => {
        o.log(`FTP session error: ${(e as Error).message}`);
        reply(451, "Something went wrong.");
      });
    }
  });

  reply(220, "Docket is ready for scans.");
}
