(function () {
  "use strict";

  if (window.__ALECAFRAME_ZH_CN_RELIC_PLANNER_CACHE__) return;
  window.__ALECAFRAME_ZH_CN_RELIC_PLANNER_CACHE__ = true;

  const stateKey = "__alecaframeZhCnRelicPlannerCache";
  const sessionKey = "__alecaframeZhCnRelicPlannerSession";
  const startedKey = "__alecaframeZhCnRelicPlannerStarted";
  const sessionId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
  let plannerStarted = false;
  let planRequestPending = false;
  let loggedItemShape = false;
  let latestItems = null;
  let latestTraceCount = "-";
  let listenerInstalled = false;
  let refreshWrapped = false;
  let appRefreshWrapped = false;

  function audit(event, detail) {
    fetch("http://127.0.0.1:38147/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: event, detail: detail || "" })
    }).catch(() => { });
  }

  function install() {
    function saveState() {
      if (!plannerStarted || !Array.isArray(latestItems)) return;
      localStorage.setItem(stateKey, JSON.stringify({
        version: 4,
        items: latestItems,
        traceCount: latestTraceCount,
        sessionId: sessionId,
        updatedAt: Date.now()
      }));
    }

    if (!listenerInstalled && window.plugin && window.plugin.get) {
      const nativePlugin = window.plugin.get();
      if (nativePlugin && nativePlugin.onRelicPlannerUpdate &&
          typeof nativePlugin.onRelicPlannerUpdate.addListener === "function") {
        nativePlugin.onRelicPlannerUpdate.addListener((result, data) => {
          try {
            if (result === "data") {
              const items = JSON.parse(data);
              if (!Array.isArray(items)) return;
              latestItems = items;
              if (planRequestPending && !plannerStarted) {
                plannerStarted = true;
                planRequestPending = false;
                localStorage.setItem(startedKey, sessionId);
                audit("RELIC_PLANNER_STARTED", "force-update-data");
              }
              if (!loggedItemShape && items.length > 0) {
                loggedItemShape = true;
                const sample = items[0] || {};
                audit("RELIC_PLANNER_ITEM_SHAPE", JSON.stringify({
                  itemKeys: Object.keys(sample),
                  normalData: sample.normalData || null,
                  custom: sample.custom || null,
                  filterSettings: window.lastRelicPlannerFilterSettings || null
                }).slice(0, 4000));
              }
              if (window.relicPlannerApp && relicPlannerApp.summaryTraces != null) {
                latestTraceCount = relicPlannerApp.summaryTraces;
              }
              saveState();
            } else if (result === "traces") {
              latestTraceCount = data == null ? "-" : data;
              saveState();
            }
          } catch (error) {
            console.warn("[AlecaFrame 中文遗物推荐] 无法缓存遗物规划结果", error);
          }
        });
        listenerInstalled = true;
      }
    }

    function wrapRefresh(target, method) {
      const originalRefresh = target && target[method];
      if (typeof originalRefresh !== "function") return false;
      if (originalRefresh.__alecaframeZhCnPlannerWrapper) return true;
      function wrappedRefreshRelicPlanner(forceUpdate, shouldShowAll) {
        if (forceUpdate === true && !plannerStarted && !planRequestPending) {
          planRequestPending = true;
          audit("RELIC_PLANNER_START_REQUESTED", "force-update");
        }
        return originalRefresh.apply(this, arguments);
      }
      wrappedRefreshRelicPlanner.__alecaframeZhCnPlannerWrapper = true;
      target[method] = wrappedRefreshRelicPlanner;
      return true;
    }

    if (!refreshWrapped) refreshWrapped = wrapRefresh(window, "RefreshRelicPlanner");
    // 3.x templates call the mounted app directly; older pages call the global
    // entry point. Wrap both while keeping one request marker for nested calls.
    if (!appRefreshWrapped) appRefreshWrapped = wrapRefresh(window.relicPlannerApp, "refresh");

    return listenerInstalled && !!window.relicPlannerApp && (refreshWrapped || appRefreshWrapped);
  }

  const timer = setInterval(() => {
    if (install()) clearInterval(timer);
  }, 250);
  // This value exists only for the current AlecaFrame run. A cached planner
  // result from an earlier run must not open a recommendation overlay.
  localStorage.setItem(sessionKey, sessionId);
  localStorage.removeItem(startedKey);
  install();
})();
