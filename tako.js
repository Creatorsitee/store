"use strict";
// Modul Tako (dari tako-cli.js): create payment, ekstrak QRIS, cek transaksi.
const axios = require("axios");
const cloudscraper = require("cloudscraper");
const puppeteer = require("puppeteer");
const jsQR = require("jsqr");
const { createCanvas, loadImage } = require("canvas");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const API_BASE = "https://tako.id/api/v1";
const SUCCESS = ["SUCCESS", "PAID", "SETTLEMENT", "COMPLETED"];
const FAILED = ["FAILED", "EXPIRED", "CANCELLED", "CANCELED"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const headers = (key) => ({ Authorization: `Bearer ${key}`, "User-Agent": UA, Accept: "application/json" });
const statusOf = (d) => String((d && d.status) || "").toUpperCase();

async function decodeQrFromBuffer(buffer) {
  const img = await loadImage(buffer);
  const scale = Math.max(1, Math.ceil(600 / Math.max(img.width, img.height)));
  const pad = 40;
  const w = img.width * scale + pad * 2;
  const h = img.height * scale + pad * 2;
  const cvs = createCanvas(w, h);
  const ctx = cvs.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, pad, pad, img.width * scale, img.height * scale);
  const data = ctx.getImageData(0, 0, w, h);
  const r = jsQR(new Uint8ClampedArray(data.data), w, h, { inversionAttempts: "attemptBoth" });
  return r && r.data ? r.data : null;
}

async function decodeDataUrl(u) {
  try {
    return await decodeQrFromBuffer(Buffer.from(u.split(",")[1], "base64"));
  } catch {
    return null;
  }
}

// Browser dibagi untuk semua order (hemat RAM); tiap order memakai page sendiri.
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      })
      .catch((e) => {
        browserPromise = null;
        throw e;
      });
  }
  return browserPromise;
}

async function extractQris(paymentUrl, { attempts = 30 } = {}) {
  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
    await page.setUserAgent(UA);
    await page.goto(paymentUrl, { waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});

    for (let i = 0; i < attempts; i++) {
      const list = await page
        .evaluate(() => {
          const out = [];
          document.querySelectorAll("canvas").forEach((cv) => {
            try {
              if (cv.width >= 50 && cv.height >= 50) out.push(cv.toDataURL("image/png"));
            } catch (_) {}
          });
          document.querySelectorAll("img").forEach((im) => {
            if (im.src && im.src.startsWith("data:image")) out.push(im.src);
          });
          return out;
        })
        .catch(() => []);
      for (const u of list) {
        const t = await decodeDataUrl(u);
        if (t) return t;
      }
      await sleep(500);
    }

    // Fallback: screenshot elemen QR, lalu seluruh halaman
    for (const h of await page.$$("canvas, img[src*='qr' i], img[alt*='qr' i]")) {
      try {
        const t = await decodeQrFromBuffer(await h.screenshot({ type: "png" }));
        if (t) return t;
      } catch (_) {}
    }
    return await decodeQrFromBuffer(await page.screenshot({ type: "png", fullPage: true }));
  } catch (e) {
    console.error("extractQris error:", e.message);
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

async function createPayment(apiKey, { username, amount, name, email }) {
  const res = await axios.post(
    `${API_BASE}/gift/${encodeURIComponent(String(username).replace(/^@/, ""))}`,
    { name: name || "store", email: email || "store@example.com", amount: Number(amount), paymentMethod: "qris" },
    { headers: headers(apiKey), timeout: 20000 }
  );
  const r = res.data.result || res.data;
  const paymentUrl = r.paymentUrl || (r.transactionId ? `https://tako.id/pay/${r.transactionId}` : null);
  if (!paymentUrl) throw new Error("Response Tako tidak berisi paymentUrl / transactionId");
  return { ...r, paymentUrl };
}

async function fetchTransaction(apiKey, txId) {
  const url = `${API_BASE}/transactions/${encodeURIComponent(String(txId).trim())}`;
  const h = headers(apiKey);
  try {
    return await new Promise((resolve, reject) => {
      cloudscraper({ method: "GET", url, headers: h, json: true }, (err, resp, body) =>
        err ? reject(err) : resolve({ status: resp.statusCode, data: body })
      );
    });
  } catch (_) {
    const r = await axios.get(url, { headers: h, timeout: 12000, validateStatus: () => true });
    return { status: r.status, data: r.data };
  }
}

module.exports = { createPayment, extractQris, fetchTransaction, statusOf, SUCCESS, FAILED, sleep };
