(function () {
  "use strict";

  const plannerStateKey = "__alecaframeZhCnRelicPlannerCache";
  const plannerSessionKey = "__alecaframeZhCnRelicPlannerSession";
  const contextKey = "__alecaframeZhCnRelicRecommendationContext";
  const legacyRecommendationStateKey = "__alecaframeZhCnRelicRecommendation";
  let lastState = "";
  let intercepted = false;

  function installChineseLayout() {
    if (document.getElementById("alecaframe-zh-cn-relic-recommendation-layout")) return;
    const style = document.createElement("style");
    style.id = "alecaframe-zh-cn-relic-recommendation-layout";
    style.textContent = [
      ".relicRecommendationContainer .relicBottom { gap: 6px; font-size: 15px; }",
      ".relicRecommendationContainer .relicDetailsBLTopExpectedTitle {",
      "  flex: 0 0 auto; font-size: 14px; overflow: visible; text-overflow: clip;",
      "}",
      ".relicRecommendationContainer .relicDetailsBLTopExpectedCoins { gap: 6px; flex-shrink: 0; }",
      ".relicRecommendationContainer .relicDetailsBLTopExpectedCoinsCoin { gap: 2px; }",
      ".relicRecommendationContainer .relicDetailsBLTopExpectedCoinsCoinIcon { width: 18px; height: 18px; }"
    ].join("\n");
    document.head.appendChild(style);
  }

  function totalGroupedExpectedValue(groups, property) {
    if (!Array.isArray(groups)) return null;
    let total = 0;
    let count = 0;
    for (const group of groups) {
      const value = Number(group && group[property]);
      if (Number.isFinite(value)) {
        total += value;
        count += 1;
      }
    }
    if (count === 0) return null;
    return Math.round(total * 100) / 100;
  }

  function withExpectedValues(item) {
    const custom = item && item.custom || {};
    const expectedPlat = custom.expectedPlat == null || custom.expectedPlat === ""
      ? totalGroupedExpectedValue(custom.groupedDetails, "expectedPlat")
      : custom.expectedPlat;
    const expectedDucats = custom.expectedDucats == null || custom.expectedDucats === ""
      ? totalGroupedExpectedValue(custom.groupedDetails, "expectedDucats")
      : custom.expectedDucats;
    return Object.assign({}, item, {
      custom: Object.assign({}, custom, { expectedPlat: expectedPlat, expectedDucats: expectedDucats })
    });
  }

  function applyState(state, context) {
    const currentSessionId = localStorage.getItem(plannerSessionKey);
    if (!state || state.version !== 4 || state.sessionId !== currentSessionId ||
        !Array.isArray(state.items) || !context || !context.era || !window.relicApp) return false;
    const eraPrefix = String(context.era) + " ";
    const items = state.items.filter((item) => item && item.normalData &&
      String(item.normalData.name || "").startsWith(eraPrefix)).map(withExpectedValues);
    if (items.length === 0) return false;
    relicApp.items = items;
    relicApp.traceCount = state.traceCount == null ? "-" : state.traceCount;
    relicApp.inProgress = false;
    relicApp.error = false;
    relicApp.loading = false;
    return true;
  }

  function applyLegacyState(state) {
    if (!state || !Array.isArray(state.items) || !window.relicApp) return false;
    const items = state.items.map(withExpectedValues);
    if (items.length === 0 && !state.loading) return false;
    relicApp.items = items;
    relicApp.traceCount = state.traceCount == null ? "-" : state.traceCount;
    relicApp.inProgress = !!state.loading;
    relicApp.error = false;
    relicApp.loading = !!state.loading;
    return true;
  }

  function installNativeUpdateGuard() {
    if (intercepted || !window.plugin || !window.plugin.get || !window.relicApp) return;
    const nativePlugin = window.plugin.get();
    if (!nativePlugin || !nativePlugin.onRelicRecommendationUpdate ||
        typeof nativePlugin.onRelicRecommendationUpdate.addListener !== "function") return;
    nativePlugin.onRelicRecommendationUpdate.addListener(() => {
      try {
        const state = JSON.parse(localStorage.getItem(plannerStateKey) || "");
        const context = JSON.parse(localStorage.getItem(contextKey) || "");
        if (state && context) {
          setTimeout(() => applyState(state, context), 0);
        }
      } catch { }
    });
    intercepted = true;
  }

  function readState() {
    try {
      const legacyRaw = localStorage.getItem(legacyRecommendationStateKey) || "";
      const raw = legacyRaw + "|" + (localStorage.getItem(plannerStateKey) || "") + "|" +
        (localStorage.getItem(contextKey) || "");
      if (!raw || raw === lastState) return;
      lastState = raw;
      const state = JSON.parse(localStorage.getItem(plannerStateKey) || "");
      const context = JSON.parse(localStorage.getItem(contextKey) || "");
      if (applyState(state, context)) {
        console.log("[AlecaFrame 中文遗物推荐] 已按 " + context.era + " 显示候选遗物");
      } else if (legacyRaw && !context.era && applyLegacyState(JSON.parse(legacyRaw))) {
        console.log("[AlecaFrame 中文遗物推荐] 已显示旧版推荐结果");
      }
    } catch (error) {
      console.warn("[AlecaFrame 中文遗物推荐] 无法读取推荐数据", error);
    }
  }

  const nativeUpdateGuardTimer = setInterval(() => {
    installNativeUpdateGuard();
    if (intercepted) clearInterval(nativeUpdateGuardTimer);
  }, 250);
  setInterval(readState, 250);
  installChineseLayout();
  installNativeUpdateGuard();
  readState();
})();
