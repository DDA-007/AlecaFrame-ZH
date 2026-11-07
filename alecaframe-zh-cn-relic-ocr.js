(function () {
  "use strict";

  if (window.__ALECAFRAME_ZH_CN_RELIC_OCR__) return;
  window.__ALECAFRAME_ZH_CN_RELIC_OCR__ = true;

  const endpoint = "http://127.0.0.1:38147/process";
  const refinementProcessEndpoint = "http://127.0.0.1:38147/process-refinement";
  const rewardProcessEndpoint = "http://127.0.0.1:38147/process-reward";
  const clearRewardEndpoint = "http://127.0.0.1:38147/clear-reward";
  const publishRewardEndpoint = "http://127.0.0.1:38147/publish-reward";
  const auditEndpoint = "http://127.0.0.1:38147/audit";
  const rewardOverlayKey = "__alecaframeZhCnRewardOverlayResult";
  const recommendationContextKey = "__alecaframeZhCnRelicRecommendationContext";
  const plannerStateKey = "__alecaframeZhCnRelicPlannerCache";
  const plannerSessionKey = "__alecaframeZhCnRelicPlannerSession";
  const plannerStartedKey = "__alecaframeZhCnRelicPlannerStarted";
  let bridgeInstalled = false;

  function audit(event, detail) {
    fetch(auditEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, detail: detail || "" })
    }).catch(() => { });
  }

  function publishRewardResult(result) {
    if (!result || !result.success || result.screenKind !== "reward" || result.rewardReady !== true ||
        !Array.isArray(result.replacements) || result.replacements.length === 0) {
      return;
    }
    const rewards = result.replacements.filter((name) => typeof name === "string" && name.trim());
    if (rewards.length === 0) return;
    try {
      // This key is intentionally separate from relic-planner state. The
      // reward overlay is opened by AlecaFrame after its native recognizer
      // returns, so sharing this short-lived OCR result avoids a race with
      // the English-only native error path.
      localStorage.setItem(rewardOverlayKey, JSON.stringify({
        rewards: rewards,
        updatedAt: Date.now()
      }));
      audit("REWARD_RESULT_CACHED", rewards.join(" | "));
    } catch (error) {
      audit("REWARD_RESULT_CACHE_FAILED", String(error && error.message || error));
    }
    fetch(publishRewardEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rewards: rewards })
    })
      .then((response) => {
        audit(response.ok ? "REWARD_RESULT_PUBLISHED" : "REWARD_RESULT_PUBLISH_FAILED", rewards.join(" | "));
      })
      .catch(() => audit("REWARD_RESULT_PUBLISH_FAILED", "request failed"));
  }

  function installBridge() {
    if (bridgeInstalled) return true;
    // Native methods exist before Initialize finishes. Installing hooks or
    // querying native events during that phase can stall application startup.
    if (window.ready !== true || window.initializationSuccessful !== true ||
        window.initializingInProgress !== false) return false;

    const originalPlugin = window.plugin;
    const media = window.overwolf && window.overwolf.media;
    if (!originalPlugin || !originalPlugin.get || !media ||
        typeof media.takeWindowsScreenshotByName !== "function") {
      return false;
    }

    const nativePlugin = originalPlugin.get();
    if (!nativePlugin || typeof nativePlugin.SetNewRelicScreenshot !== "function") {
      return false;
    }

    const capture = window.__ALECAFRAME_ZH_CN_OCR_CAPTURE__;
    if (!capture?.start()) return false;

    try {
      const methodNames = [];
      let current = nativePlugin;
      while (current && current !== Object.prototype) {
        Object.getOwnPropertyNames(current).forEach((name) => {
          if (methodNames.indexOf(name) === -1) methodNames.push(name);
        });
        current = Object.getPrototypeOf(current);
      }
      audit("NATIVE_MEMBERS", methodNames.sort().join(","));
      ["OpenRelicRecommendations", "DoRelicRecommendationTest", "SetNewRelicScreenshot"].forEach((name) => {
        if (typeof nativePlugin[name] === "function") {
          audit("NATIVE_SIGNATURE", name + " arity=" + nativePlugin[name].length + " source=" + String(nativePlugin[name]).slice(0, 180));
        }
      });
    } catch (error) {
      audit("NATIVE_MEMBERS_FAILED", String(error && error.message || error));
    }

    const nativeSetNewRelicScreenshot = nativePlugin.SetNewRelicScreenshot;
    const originalTakeScreenshot = media.takeWindowsScreenshotByName;
    let conversionInProgress = false;
    let activeNativeScreenshotRequest = 0;
    let lastSuccessfulConversionAt = 0;
    let lastPublishedEra = "";
    let lastRecommendationOpenedAt = 0;
    let lastRecommendationSubmittedAt = 0;
    let lastRefinementMatchAt = 0;
    let lastUnplannedRecommendationAuditAt = 0;

    function hasCurrentPlannerResult() {
      try {
        const sessionId = localStorage.getItem(plannerSessionKey);
        const startedSessionId = localStorage.getItem(plannerStartedKey);
        const plannerState = JSON.parse(localStorage.getItem(plannerStateKey) || "");
        return !!(sessionId && startedSessionId === sessionId && plannerState && plannerState.version === 4 &&
          plannerState.sessionId === sessionId && Array.isArray(plannerState.items) &&
          plannerState.items.length > 0);
      } catch {
        return false;
      }
    }
    function publishRecommendationEra(era) {
      if (!era) return false;
      try {
        const now = Date.now();
        if (era === lastPublishedEra && now - lastRecommendationOpenedAt < 2500) {
          return true;
        }
        localStorage.setItem(recommendationContextKey, JSON.stringify({
          era: era,
          updatedAt: now
        }));
        lastPublishedEra = era;
        audit("RECOMMENDATION_ERA_PUBLISHED", era);
        return true;
      } catch (error) {
        audit("RECOMMENDATION_ERA_PUBLISH_FAILED", String(error && error.message || error));
        return false;
      }
    }

    if (nativePlugin.onRelicRecommendationUpdate &&
        typeof nativePlugin.onRelicRecommendationUpdate.addListener === "function") {
      nativePlugin.onRelicRecommendationUpdate.addListener((type, data, extra) => {
        audit("NATIVE_RECOMMENDATION_UPDATE", String(type) + " " + String(data || "").slice(0, 240) + " " + String(extra || ""));
      });
    }

    function submitConvertedRelicScreenshot(imagePath, callback, openRecommendation, era, screenKind) {
      const isRecommendationScreen = openRecommendation && screenKind === "refinement";
      if (isRecommendationScreen && !hasCurrentPlannerResult()) {
        if (Date.now() - lastUnplannedRecommendationAuditAt >= 10000) {
          lastUnplannedRecommendationAuditAt = Date.now();
          audit("RECOMMENDATION_SKIPPED_NO_CURRENT_PLAN", imagePath);
        }
        if (typeof callback === "function") callback();
        return;
      }
      const now = Date.now();
      const eraChanged = !!era && era !== lastPublishedEra;
      // The refinement probe runs periodically while this page remains open.
      // Re-submitting the same era makes the native layer re-create its window
      // and produces visible flicker. The recommendation page observes the
      // planner/context cache itself, so an already-open same-era overlay does
      // not need another native screenshot or open request.
      if (isRecommendationScreen && !eraChanged) {
        audit("RECOMMENDATION_REFRESH_SKIPPED", "era=" + era + " ageMs=" + (now - lastRecommendationSubmittedAt));
        if (typeof callback === "function") callback();
        return;
      }
      const canOpenRecommendation = openRecommendation && screenKind === "refinement" &&
        publishRecommendationEra(era);
      if (openRecommendation && !canOpenRecommendation) {
        audit("RECOMMENDATION_ERA_NOT_DETECTED", imagePath);
      }
      const openRecommendationWindow = () => {
        if (isRecommendationScreen) lastRecommendationSubmittedAt = Date.now();
        if (canOpenRecommendation && typeof nativePlugin.OpenRelicRecommendations === "function") {
          try {
            if (eraChanged || !lastRecommendationOpenedAt) {
              nativePlugin.OpenRelicRecommendations();
              lastRecommendationOpenedAt = Date.now();
              audit("NATIVE_RECOMMENDATIONS_OPEN_REQUESTED", imagePath);
            }
          } catch (error) {
            audit("NATIVE_RECOMMENDATIONS_OPEN_FAILED", String(error && error.message || error));
          }
        }
        if (typeof callback === "function") callback();
      };
      nativeSetNewRelicScreenshot.call(nativePlugin, imagePath, false, () => {
        audit("NATIVE_SCREENSHOT_SUBMITTED", imagePath);
        openRecommendationWindow();
      });
    }

    function submitScreenshot(fileData, callback, requestId) {
      if (!fileData || !fileData.path || conversionInProgress) return;
      audit("SCREENSHOT", "request=" + (requestId || 0) + " " + fileData.path);
      conversionInProgress = true;
      audit("OCR_FETCH_STARTED", "request=" + (requestId || 0) + " " + fileData.path);
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: fileData.path })
      })
        .then((response) => response.ok ? response.json() : Promise.reject(new Error("OCR helper unavailable")))
        .then((result) => {
          const imagePath = result && result.success && result.outputPath ? result.outputPath : fileData.path;
          audit("OCR_FETCH_RESULT", "request=" + (requestId || 0) + " " + JSON.stringify({
            success: !!(result && result.success),
            screenKind: result && result.screenKind || "",
            replacements: result && result.replacements || []
          }));
          if (result && result.success) {
            lastSuccessfulConversionAt = Date.now();
            publishRewardResult(result);
            console.log("[AlecaFrame 中文遗物 OCR] 已转换：" + result.replacements.join(", "));
          }
          // A SetNewRelicScreenshot call is converted directly. The media
          // request path below must only return its matching image through
          // the original callback; submitting it here would create a second,
          // unrelated native recognition request.
          if (requestId) {
            if (requestId !== activeNativeScreenshotRequest) {
              audit("OCR_FETCH_STALE", "request=" + requestId);
              if (typeof callback === "function") callback({ success: true, path: fileData.path });
              return;
            }
            if (typeof callback === "function") callback({ success: true, path: imagePath });
            audit("NATIVE_REQUEST_RETURNED", "request=" + requestId + " " + imagePath);
            return;
          }
          submitConvertedRelicScreenshot(imagePath, callback, !!(result && result.success), result && result.era, result && result.screenKind);
        })
        .catch((error) => {
          audit("OCR_FETCH_FAILED", String(error && error.message || error));
          console.log("[AlecaFrame 中文遗物 OCR] 本地服务不可用，回退官方识别。");
          if (requestId) {
            if (typeof callback === "function") callback({ success: true, path: fileData.path });
          } else {
            submitConvertedRelicScreenshot(fileData.path, callback, false, null, null);
          }
        })
        .finally(() => { conversionInProgress = false; });
    }

    let rewardNativeCaptureInProgress = false;
    window.__ALECAFRAME_ZH_CN_CAPTURE_REWARD__ = async function () {
      if (rewardNativeCaptureInProgress) return;
      rewardNativeCaptureInProgress = true;
      try {
        await fetch(clearRewardEndpoint, { method: "POST" }).catch(() => { });
        try { localStorage.removeItem(rewardOverlayKey); } catch { }
        for (let attempt = 1; attempt <= 3; attempt++) {
          const result = await capture.capture(rewardProcessEndpoint, false);
          if (result?.success) {
            publishRewardResult(result);
            audit("REWARD_NATIVE_CAPTURE_MATCH", "attempt=" + attempt);
            return;
          }
          if (result?.resourceLimited) break;
          if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 350));
        }
        audit("REWARD_NATIVE_CAPTURE_NO_MATCH");
      } catch (error) {
        audit("REWARD_NATIVE_CAPTURE_OCR_FAILED", String(error?.message || error));
      } finally {
        rewardNativeCaptureInProgress = false;
      }
    };

    // Preserve AlecaFrame's normal English workflow and transform only the
    // screenshots it already sends to the native relic recognizer.
    nativePlugin.SetNewRelicScreenshot = function (imagePath, debugMode, callback) {
      audit("NATIVE_SET_SCREENSHOT_ENTER", "converting=" + conversionInProgress + " " + imagePath);
      if (debugMode) {
        return nativeSetNewRelicScreenshot.call(nativePlugin, imagePath, debugMode, callback);
      }
      // The native background flow invokes this method immediately from the
      // screenshot callback while the media wrapper is still awaiting its
      // promise cleanup. That image is already the OCR-converted result and
      // must reach the original native recognizer; treating it as a second
      // conversion drops the submission and prevents the reward window from
      // being created at all.
      if (conversionInProgress) {
        audit("NATIVE_CONVERTED_SCREENSHOT_FORWARDED", imagePath);
        return nativeSetNewRelicScreenshot.call(nativePlugin, imagePath, debugMode, callback);
      }
      submitScreenshot({ path: imagePath }, callback, 0);
    };

    // Keep the native recognizer's request/response state machine intact. It
    // requests a screenshot first, then decides whether to open the
    // recommendation overlay after SetNewRelicScreenshot completes. Returning
    // the converted image from this existing API call is therefore more
    // reliable than submitting an unrelated screenshot on a timer.
    media.takeWindowsScreenshotByName = function (windowName, includeCursor, callback) {
      if (windowName !== "Warframe" || typeof callback !== "function" || conversionInProgress) {
        return originalTakeScreenshot.apply(media, arguments);
      }
      const requestId = ++activeNativeScreenshotRequest;
      audit("NATIVE_REQUEST_CAPTURE", "request=" + requestId);
      // The reward overlay can be created before the new OCR finishes. Clear
      // the prior mission's short-lived result first so it cannot populate a
      // new window with an otherwise valid but wrong reward list.
      fetch(clearRewardEndpoint, { method: "POST" }).catch(() => { }).finally(() => originalTakeScreenshot.call(media, windowName, includeCursor, (fileData) => {
        if (!fileData || !fileData.success || !fileData.path) {
          audit("NATIVE_REQUEST_CAPTURE_FAILED", "request=" + requestId);
          callback(fileData);
          return;
        }
        submitScreenshot(fileData, callback, requestId);
      }));
      return;
    };

    // Probe the refinement UI only for a current planner session.
    let lastProbeAt = 0;
    let wasWarframeFocused = false;
    async function probeFocusedWarframe() {
      if (!capture.isFocused()) {
        wasWarframeFocused = false;
        return;
      }
      const now = Date.now();
      if (conversionInProgress || now - lastSuccessfulConversionAt < 1200) return;
      if (wasWarframeFocused && now - lastProbeAt < 2500) return;
      wasWarframeFocused = true;
      lastProbeAt = now;
      if (!hasCurrentPlannerResult()) return;

      conversionInProgress = true;
      try {
        const result = await capture.capture(refinementProcessEndpoint);
        if (result?.success && result.screenKind === "refinement" && result.outputPath) {
          lastSuccessfulConversionAt = Date.now();
          lastRefinementMatchAt = lastSuccessfulConversionAt;
          audit("REFINEMENT_NATIVE_CAPTURE_MATCH", "era=" + (result.era || ""));
          submitConvertedRelicScreenshot(result.outputPath, null, true, result.era, result.screenKind);
        } else if (lastRefinementMatchAt && Date.now() - lastRefinementMatchAt >= 3000) {
          lastPublishedEra = "";
          lastRecommendationOpenedAt = 0;
          lastRecommendationSubmittedAt = 0;
          lastRefinementMatchAt = 0;
          audit("RECOMMENDATION_CONTEXT_CLEARED", "left refinement screen");
        }
      } catch (error) {
        audit("REFINEMENT_NATIVE_CAPTURE_OCR_FAILED", String(error?.message || error));
      } finally {
        conversionInProgress = false;
      }
    }
    setInterval(probeFocusedWarframe, 400);

    bridgeInstalled = true;
    audit("BRIDGE_INSTALLED");
    console.log("[AlecaFrame 中文遗物 OCR] 已加载");
    return true;
  }

  // background.js initializes AlecaFrame's native wrapper asynchronously.
  // Wait for the actual native methods instead of installing against a shell.
  const installTimer = setInterval(() => {
    if (installBridge()) clearInterval(installTimer);
  }, 250);
  installBridge();
})();
