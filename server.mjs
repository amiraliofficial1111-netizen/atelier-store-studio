import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".hdr": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
};

function lanIPv4() {
  const nets = os.networkInterfaces();
  const addresses = [];
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      const v4 = net.family === "IPv4" || net.family === 4;
      if (v4 && !net.internal) addresses.push(net.address);
    }
  }
  return addresses.find((ip) => ip.startsWith("192.168.") || ip.startsWith("10.")) || addresses[0] || "";
}

let publicOrigin = "";

function readSavedOrigin() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, "share-origin.json"), "utf8"));
    if (typeof data.origin === "string" && data.origin.startsWith("https://")) return data.origin.replace(/\/$/, "");
  } catch {}
  return "";
}

function writeOrigin(origin) {
  publicOrigin = origin.replace(/\/$/, "");
  fs.writeFileSync(path.join(root, "share-origin.json"), JSON.stringify({ origin: publicOrigin }, null, 2));
  console.log(`Public link  ${publicOrigin}`);
}

function shareOriginNow() {
  if (!publicOrigin) publicOrigin = readSavedOrigin();
  if (publicOrigin) return publicOrigin;
  const ip = lanIPv4();
  return ip ? `http://${ip}:${port}` : `http://localhost:${port}`;
}

function startTunnel() {
  const bin = path.join(root, "_tools", "cloudflared.exe");
  if (!fs.existsSync(bin)) {
    console.log("Public tunnel skipped");
    return;
  }
  const child = spawn(bin, ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const onData = (buf) => {
    const text = buf.toString();
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (match && match[0] !== publicOrigin) writeOrigin(match[0]);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code) => console.log(`tunnel stopped ${code ?? ""}`));
}

function send(res, code, body, type = "text/plain; charset=utf-8") {
  res.writeHead(code, {
    "Content-Type": type,
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function shopFileId(value) {
  const id = String(value || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return /^[a-z0-9_-]+$/i.test(id) ? id : "";
}

function listShopFiles() {
  const dir = path.join(root, "shops");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => {
    const id = name.slice(0, -5);
    let title = id;
    let sign = "";
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      sign = data?.store?.sign?.text || "";
      title = sign || data?.presetId || id;
    } catch {}
    return { id, title, sign };
  }).filter((row) => shopFileId(row.id));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 20_000_000) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (req.method === "OPTIONS" && (url.pathname === "/api/share-host" || url.pathname === "/api/publish" || url.pathname === "/api/shops" || url.pathname === "/api/upload")) {
    send(res, 204, "");
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/shops") {
    send(res, 200, JSON.stringify({ shops: listShopFiles() }), "application/json; charset=utf-8");
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/upload") {
    let raw = "";
    try {
      raw = await readBody(req);
    } catch {
      send(res, 413, "too large");
      return;
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      send(res, 400, "bad json");
      return;
    }
    const shops = Array.isArray(body.shops) ? body.shops : [];
    if (!shops.length) {
      send(res, 400, "no shops");
      return;
    }
    const dir = path.join(root, "shops");
    fs.mkdirSync(dir, { recursive: true });
    const saved = [];
    for (const row of shops) {
      const id = shopFileId(row?.id);
      if (!id || !row?.payload?.store) continue;
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(row.payload, null, 2));
      saved.push(id);
    }
    if (!saved.length) {
      send(res, 400, "no shops");
      return;
    }
    send(res, 200, JSON.stringify({ ok: true, ids: saved }), "application/json; charset=utf-8");
    return;
  }
  if (url.pathname === "/api/share-host") {
    send(res, 200, JSON.stringify({ origin: shareOriginNow() }), "application/json; charset=utf-8");
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/publish") {
    let raw = "";
    try {
      raw = await readBody(req);
    } catch {
      send(res, 413, "too large");
      return;
    }
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      send(res, 400, "bad json");
      return;
    }
    const id = String(body.id || "");
    if (!/^[a-z0-9_-]+$/i.test(id)) {
      send(res, 400, "bad id");
      return;
    }
    const dir = path.join(root, "shops");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(body.payload ?? {}, null, 2));
    send(res, 200, JSON.stringify({ ok: true }), "application/json; charset=utf-8");
    return;
  }

  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith("/")) rel += "index.html";
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(root, rel));
  const fromRoot = path.relative(root, file);
  if (fromRoot.startsWith("..") || path.isAbsolute(fromRoot)) {
    send(res, 403, "forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      send(res, 404, "not found");
      return;
    }
    send(res, 200, data, types[path.extname(file).toLowerCase()] || "application/octet-stream");
  });
});

server.listen(port, "0.0.0.0", () => {
  const ip = lanIPv4();
  console.log(`This computer  http://localhost:${port}`);
  if (ip) console.log(`Same Wi-Fi     http://${ip}:${port}`);
  startTunnel();
});
