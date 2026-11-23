import assert from "node:assert/strict";
import net from "node:net";
import { after, before, test } from "node:test";
import { startFtpServer } from "../src/services/ftp.ts";

const received: Array<{ name: string; data: Buffer }> = [];
let failNext: string | null = null;
let server: net.Server;
let port: number;

before(async () => {
  server = await startFtpServer({
    port: 0,
    host: "127.0.0.1",
    user: "scanner",
    password: "s3cret",
    pasvPorts: [0, 0],
    maxBytes: 1024 * 1024,
    log: () => {},
    onFile: async (data, name) => {
      if (failNext) { const m = failNext; failNext = null; throw new Error(m); }
      received.push({ name, data });
      return "ok";
    },
  });
  port = (server.address() as net.AddressInfo).port;
});
after(() => server.close());

/** A minimal FTP client: send a command, read the complete reply. */
async function connect() {
  const s = net.connect(port, "127.0.0.1");
  s.setEncoding("utf8");
  let buf = "";
  const waiters: Array<(line: string) => void> = [];
  s.on("data", (c: string) => {
    buf += c;
    for (;;) {
      // A reply ends with a line "NNN text" (space after the code).
      const m = buf.match(/^(?:.*\r\n)*?(\d{3}) .*\r\n/);
      if (!m) break;
      buf = buf.slice(m[0].length);
      waiters.shift()?.(m[0].trim().split("\r\n").pop()!);
    }
  });
  const next = () => new Promise<string>((r) => waiters.push(r));
  const cmd = async (line: string) => { const p = next(); s.write(line + "\r\n"); return p; };
  assert.match(await next(), /^220/);
  return { s, cmd, next };
}

async function login() {
  const c = await connect();
  assert.match(await c.cmd("USER scanner"), /^331/);
  assert.match(await c.cmd("PASS s3cret"), /^230/);
  return c;
}

async function epsv(cmd: (l: string) => Promise<string>) {
  const r = await cmd("EPSV");
  const p = Number(r.match(/\(\|\|\|(\d+)\|\)/)![1]);
  return net.connect(p, "127.0.0.1");
}

test("an upload reaches onFile only after the transfer completes, then 226", async () => {
  const c = await login();
  const d = await epsv(c.cmd);
  await new Promise((r) => d.once("connect", r));
  const reply150 = c.cmd("STOR /scans/2026/receipt.pdf");
  assert.match(await reply150, /^150/);
  const done = c.next();
  d.write("%PDF-1.7 part one ");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(received.length, 0, "nothing is taken while the scanner is still sending");
  d.end("part two %%EOF");
  assert.match(await done, /^226/);
  const got = received.pop()!;
  assert.equal(got.name, "receipt.pdf");
  assert.equal(got.data.toString(), "%PDF-1.7 part one part two %%EOF");
  c.s.end();
});

test("PASV works too", async () => {
  const c = await login();
  const r = await c.cmd("PASV");
  const n = r.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/)!.slice(1).map(Number);
  assert.equal(n.slice(0, 4).join("."), "127.0.0.1");
  const d = net.connect(n[4] * 256 + n[5], "127.0.0.1");
  assert.match(await c.cmd("STOR scan.pdf"), /^150/);
  const done = c.next();
  d.end("%PDF-1.4 hello %%EOF");
  assert.match(await done, /^226/);
  assert.equal(received.pop()!.name, "scan.pdf");
  c.s.end();
});

test("a transfer cut off mid-file is not taken", async () => {
  const c = await login();
  const d = await epsv(c.cmd);
  assert.match(await c.cmd("STOR half.pdf"), /^150/);
  const done = c.next();
  d.write("%PDF-1.7 only half");
  await new Promise((r) => setTimeout(r, 20));
  d.resetAndDestroy();
  assert.match(await done, /^426/);
  assert.equal(received.length, 0);
  c.s.end();
});

test("when Docket can't take the file, the scanner hears a failure", async () => {
  const c = await login();
  const d = await epsv(c.cmd);
  failNext = "Unsupported file type";
  assert.match(await c.cmd("STOR notes.docx"), /^150/);
  const done = c.next();
  d.end("PK....");
  assert.match(await done, /^451 .*Unsupported file type/);
  c.s.end();
});

test("wrong password is refused, and nothing works before logging in", async () => {
  const c = await connect();
  assert.match(await c.cmd("STOR x.pdf"), /^530/);
  assert.match(await c.cmd("USER scanner"), /^331/);
  assert.match(await c.cmd("PASS nope"), /^530/);
  assert.match(await c.cmd("EPSV"), /^530/);
  c.s.end();
});

test("active mode only connects back to the client itself", async () => {
  const c = await login();
  assert.match(await c.cmd("PORT 10,0,0,9,4,1"), /^504/);
  assert.match(await c.cmd("EPRT |1|127.0.0.1|1025|"), /^200/);
  c.s.end();
});

test("the folder commands scanners send before uploading succeed", async () => {
  const c = await login();
  assert.match(await c.cmd("TYPE I"), /^200/);
  assert.match(await c.cmd("MKD scans"), /^257/);
  assert.match(await c.cmd("CWD scans"), /^250/);
  assert.match(await c.cmd("PWD"), /^257 "\/scans"/);
  assert.match(await c.cmd("FEAT"), /^211 End/);
  assert.match(await c.cmd("RETR anything"), /^550/);
  assert.match(await c.cmd("QUIT"), /^221/);
});
