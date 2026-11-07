(function () {
  "use strict";

  const key = "__ALECAFRAME_ZH_CN_OCR_CAPTURE__";
  if (window[key]) return;
  const base = "http://127.0.0.1:38147";
  let game = null;
  let started = false;
  let screenshotBuffer = null;
  let canvas = null;
  let captureInProgress = false;
  let retryAt = 0;
  let generation = 0;
  let releaseTimer = null;

  function releaseBuffer() {
    generation++;
    clearTimeout(releaseTimer);
    releaseTimer = null;
    if (screenshotBuffer) {
      try { screenshotBuffer.close(); } catch { /* The native window may have closed. */ }
      screenshotBuffer = null;
    }
    if (canvas) canvas.width = 0;
    canvas = null;
  }

  function isWarframe(info) {
    return info?.isRunning && (Number(info.classId) === 8954 ||
      Math.floor(Number(info.id) / 10) === 8954 || info.title === "Warframe");
  }

  function setGame(info) {
    const next = isWarframe(info) ? info : null;
    if (game && (!next || next.processId !== game.processId ||
        next.width !== game.width || next.height !== game.height)) releaseBuffer();
    game = next;
    if (next?.gameIsInFocus) {
      clearTimeout(releaseTimer);
      releaseTimer = null;
    } else if (next && screenshotBuffer && releaseTimer === null) {
      releaseTimer = setTimeout(releaseBuffer, 15000);
    }
  }

  function start() {
    if (started) return true;
    const games = window.overwolf?.games;
    if (!games || typeof games.getRunningGameInfo !== "function") return false;
    started = true;
    let revision = 0;
    let querying = false;
    function refresh() {
      if (querying) return;
      querying = true;
      const before = revision;
      try {
        games.getRunningGameInfo(info => {
          querying = false;
          if (before === revision) setGame(info?.success ? info : null);
        });
      } catch {
        querying = false;
      }
    }
    function onUpdate(event) {
      revision++;
      setGame(event?.gameInfo);
    }
    const updates = games.onGameInfoUpdated;
    const canSubscribe = typeof updates?.addListener === "function";
    if (canSubscribe) updates.addListener(onUpdate);
    const timer = canSubscribe ? null : setInterval(refresh, 5000);
    window.addEventListener("unload", () => {
      releaseBuffer();
      updates?.removeListener?.(onUpdate);
      if (timer !== null) clearInterval(timer);
    }, { once: true });
    refresh();
    return true;
  }

  function nativeResult(call, disposeLate = () => {}) {
    return new Promise((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        reject(new Error("Overwolf capture callback timed out."));
      }, 4000);
      try {
        call(result => {
          clearTimeout(timer);
          if (expired) disposeLate(result);
          else resolve(result);
        });
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async function grab(media, currentGeneration) {
    if (!screenshotBuffer) {
      const result = await nativeResult(callback => media.createScreenshotBuffer({ format: "rgba" }, callback),
        late => { try { late?.screenshotBuffer?.close(); } catch { } });
      if (!result?.success || !result.screenshotBuffer) throw new Error(result?.error || "Unable to create capture buffer.");
      if (generation !== currentGeneration) {
        result.screenshotBuffer.close();
        throw new Error("Game changed while opening capture buffer.");
      }
      screenshotBuffer = result.screenshotBuffer;
    }

    const frame = await nativeResult(callback => screenshotBuffer.capture(callback));
    if (!frame?.success) throw new Error(frame?.error || "Unable to capture game frame.");
    const { width, height, stride, format, buffer } = frame;
    if (format !== "rgba" || !Number.isInteger(width) || !Number.isInteger(height) ||
        width <= 0 || height <= 0 || width * height > 40000000 ||
        stride !== width * 4 || buffer?.byteLength !== stride * height) {
      throw new Error("Unexpected Overwolf frame layout.");
    }
    if (generation !== currentGeneration) throw new Error("Game changed while capturing.");
    canvas ||= document.createElement("canvas");
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const pixels = new Uint8ClampedArray(buffer);
    canvas.getContext("2d", { alpha: false }).putImageData(new ImageData(pixels, width, height), 0, 0);
    return new Promise((resolve, reject) => canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error("Unable to encode game frame.")), "image/jpeg", 0.95));
  }

  function isFocused() { return game?.gameIsInFocus === true; }

  async function capture(endpoint, requireFocus = true) {
    if (captureInProgress) return { success: false, busy: true };
    if (!game || (requireFocus && !isFocused())) return { success: false };
    if (Date.now() < retryAt) return { success: false, resourceLimited: true };
    captureInProgress = true;
    const currentGeneration = generation;
    try {
      const permit = await fetch(base + "/capture-permit", { cache: "no-store", signal: AbortSignal.timeout(2000) });
      if (!permit.ok) {
        releaseBuffer();
        retryAt = Date.now() + 5000;
        return { success: false, resourceLimited: true };
      }
      if (generation !== currentGeneration || !game || (requireFocus && !isFocused())) return { success: false };

      const media = window.overwolf?.media;
      const buffered = typeof media?.createScreenshotBuffer === "function";
      const body = buffered ? await grab(media, currentGeneration) : JSON.stringify({ foreground: true });
      if (generation !== currentGeneration || (requireFocus && !isFocused())) return { success: false };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": buffered ? "image/jpeg" : "application/json" },
        body,
        signal: AbortSignal.timeout(60000)
      });
      if (!response.ok) {
        if (response.status === 503) releaseBuffer();
        retryAt = Date.now() + 5000;
        return { success: false, resourceLimited: true };
      }
      const result = await response.json();
      return generation === currentGeneration ? result : { success: false };
    } catch (error) {
      releaseBuffer();
      retryAt = Date.now() + 5000;
      return { success: false, resourceLimited: true, reason: String(error?.message || error) };
    } finally {
      captureInProgress = false;
    }
  }

  window[key] = { start, isFocused, capture };
})();
