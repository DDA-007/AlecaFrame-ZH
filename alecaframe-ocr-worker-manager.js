"use strict";

const { spawn } = require("child_process");
const os = require("os");

const MiB = 1024 * 1024;
const limited = reason => ({ success: false, resourceLimited: true, reason });

// One resident model, one inference, and at most two waiting paths. Never store
// image buffers here or start a replacement until the previous child has closed.
class OcrWorkerManager {
  constructor(options) {
    this.options = options;
    this.spawn = options.spawn || spawn;
    this.freeMemory = options.freeMemory || os.freemem;
    this.audit = options.audit || (() => {});
    this.startupMs = options.startupMs ?? 120000;
    this.requestMs = options.requestMs ?? 30000;
    this.maxRequests = options.maxRequests ?? Infinity;
    this.privateLimitBytes = options.privateLimitBytes ?? 1536 * MiB;
    this.minimumFreeBytes = options.minimumFreeBytes ?? Math.max(512 * MiB, os.totalmem() * 0.03);
    this.queue = [];
    this.active = null;
    this.worker = null;
    this.sequence = 0;
    this.closed = false;
    this.pumping = false;
    this.cooldownUntil = 0;
    this.memoryTimer = setInterval(() => {
      if (this.worker && this.freeMemory() < this.minimumFreeBytes) {
        this.cooldownUntil = Date.now() + 30000;
        this.stopWorker("PADDLE_MEMORY_PRESSURE");
      }
    }, options.memoryCheckMs ?? 2000);
    this.memoryTimer.unref?.();
  }

  status() {
    const worker = this.worker;
    return {
      state: this.closed ? "closed" : !worker ? "idle" : worker.stopping ? "stopping" : !worker.ready ? "starting" : this.active ? "busy" : "ready",
      pid: worker?.child.pid || null, pending: this.queue.length,
      completed: worker?.completed || 0, privateBytes: worker?.privateBytes || 0,
      privateLimitBytes: this.privateLimitBytes
    };
  }

  run(imagePath, crop = null, extra = {}) {
    if (this.closed) return Promise.resolve(limited("OCR service stopped."));
    const key = JSON.stringify({ path: imagePath, crop, ...extra });
    const duplicate = [this.active, ...this.queue].find(job => job?.key === key);
    if (duplicate) return duplicate.promise;
    if (this.queue.length >= 2) return Promise.resolve(limited("OCR queue is full; discard this old frame."));
    if (Date.now() < this.cooldownUntil || this.freeMemory() < this.minimumFreeBytes) {
      return Promise.resolve(limited("OCR paused to preserve available memory."));
    }
    const job = { key, payload: { path: imagePath, crop, ...extra, id: ++this.sequence } };
    job.promise = new Promise(resolve => { job.resolve = resolve; });
    this.queue.push(job);
    this.pump().catch(error => {
      this.audit("PADDLE_MANAGER_ERROR", String(error.message));
      this.active?.resolve(limited("OCR worker failed."));
      for (const pending of this.queue.splice(0)) pending.resolve(limited("OCR worker failed."));
      this.active = null;
      this.stopWorker("PADDLE_MANAGER_ERROR");
    });
    return job.promise;
  }

  async ensureWorker() {
    if (this.closed || Date.now() < this.cooldownUntil || this.freeMemory() < this.minimumFreeBytes) return false;
    if (this.worker?.stopping) {
      let timer;
      await Promise.race([this.worker.closedPromise, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
      clearTimeout(timer);
      if (this.worker) return false; // Fail closed if termination was not confirmed.
    }
    if (this.closed || Date.now() < this.cooldownUntil || this.freeMemory() < this.minimumFreeBytes) return false;
    if (this.worker) return this.worker.startPromise;
    const slot = { ready: false, stopping: false, completed: 0, privateBytes: 0, buffer: "" };
    slot.startPromise = new Promise(resolve => { slot.resolveStart = resolve; });
    slot.closedPromise = new Promise(resolve => { slot.resolveClosed = resolve; });
    this.worker = slot;
    try {
      slot.child = this.spawn(this.options.pythonPath, [this.options.workerPath], {
        windowsHide: true, env: this.options.env || process.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      this.worker = null;
      slot.resolveClosed(); slot.resolveStart(false);
      this.audit("PADDLE_START_FAILED", error.message);
      return false;
    }
    this.audit("PADDLE_START", "pid=" + slot.child.pid);
    slot.startTimer = setTimeout(() => {
      if (this.worker === slot && !slot.ready) {
        this.cooldownUntil = Date.now() + 5000;
        this.stopWorker("PADDLE_START_TIMEOUT");
      }
    }, this.startupMs);
    slot.child.stdout.setEncoding("utf8");
    slot.child.stdout.on("data", chunk => {
      if (this.worker !== slot || slot.stopping) return;
      slot.buffer += chunk;
      if (slot.buffer.length > 2 * MiB) { this.stopWorker("PADDLE_OUTPUT_LIMIT"); return; }
      let newline;
      while ((newline = slot.buffer.indexOf("\n")) >= 0) {
        const line = slot.buffer.slice(0, newline).trim();
        slot.buffer = slot.buffer.slice(newline + 1);
        if (!line) continue;
        let response;
        try { response = JSON.parse(line); }
        catch { this.audit("PADDLE_PROTOCOL_INVALID", line.slice(0, 160)); continue; }
        if (Number.isFinite(response.privateBytes)) slot.privateBytes = response.privateBytes;
        if (response.ready === true) {
          clearTimeout(slot.startTimer);
          slot.ready = true;
          slot.resolveStart(true);
          this.audit("PADDLE_READY", "pid=" + slot.child.pid + " privateBytes=" + slot.privateBytes);
        } else if (this.active?.slot === slot && response.id === this.active.payload.id) {
          this.active.finish?.(response);
        } else { this.audit("PADDLE_STALE_RESPONSE", "id=" + response.id); }
      }
    });
    slot.child.stderr.setEncoding("utf8");
    slot.child.stderr.on("data", chunk => this.audit("PADDLE_STDERR", chunk.trim().slice(0, 300)));
    slot.child.stdin.on("error", () => {
      if (this.worker === slot) this.stopWorker("PADDLE_PIPE_ERROR");
    });
    slot.child.on("error", error => {
      this.audit("PADDLE_START_FAILED", error.message);
      if (this.worker === slot) this.stopWorker("PADDLE_PROCESS_ERROR");
    });
    slot.child.once("close", code => {
      clearTimeout(slot.startTimer);
      slot.resolveStart(false);
      slot.resolveClosed();
      slot.buffer = "";
      if (this.worker !== slot) return;
      if (this.active?.slot === slot) this.active.finish?.(limited("Paddle worker exited."));
      this.worker = null;
      this.audit("PADDLE_EXIT", "pid=" + slot.child.pid + " code=" + code);
      if (!slot.stopping) this.cooldownUntil = Date.now() + 5000;
    });
    return slot.startPromise;
  }

  stopWorker(reason) {
    const slot = this.worker;
    if (!slot || slot.stopping) return slot?.closedPromise || Promise.resolve();
    slot.stopping = true;
    slot.ready = false;
    clearTimeout(slot.startTimer);
    slot.resolveStart(false);
    if (this.active?.slot === slot) this.active.finish?.(limited(reason));
    this.audit(reason, "pid=" + slot.child?.pid);
    try { slot.child?.kill(); }
    catch (error) { this.audit("PADDLE_STOP_FAILED", error.message); }
    // Keep this slot until close; a late exit cannot reset a newer worker.
    return slot.closedPromise;
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && !this.closed) {
        const job = this.queue.shift();
        this.active = job;
        if (!(await this.ensureWorker()) || this.closed || !this.worker?.ready) {
          job.resolve(limited("Paddle worker is unavailable.")); this.active = null; continue;
        }
        const slot = this.worker;
        job.slot = slot;
        const response = await new Promise(resolve => {
          let finished = false;
          const timer = setTimeout(() => {
            this.cooldownUntil = Date.now() + 5000;
            this.stopWorker("PADDLE_REQUEST_TIMEOUT");
          }, this.requestMs);
          job.finish = result => {
            if (finished) return;
            finished = true; clearTimeout(timer); resolve(result);
          };
          try {
            slot.child.stdin.write(JSON.stringify(job.payload) + "\n", error => {
              if (error && this.worker === slot) this.stopWorker("PADDLE_PIPE_ERROR");
            });
          } catch { this.stopWorker("PADDLE_PIPE_ERROR"); }
        });
        slot.completed++;
        job.finish = null;
        job.resolve(response);
        this.active = null;
        if (response.resourceLimited || slot.completed >= this.maxRequests || slot.privateBytes >= this.privateLimitBytes) {
          this.stopWorker(response.resourceLimited ? "PADDLE_RESOURCE_RECYCLE" : "PADDLE_MEMORY_RECYCLE");
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.memoryTimer);
    for (const job of this.queue.splice(0)) job.resolve(limited("OCR service stopped."));
    this.active?.resolve(limited("OCR service stopped."));
    return this.stopWorker("PADDLE_SERVICE_STOP");
  }
}

module.exports = { OcrWorkerManager };
