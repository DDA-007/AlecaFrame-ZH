(function () {
  "use strict";

  if (window.__ALECAFRAME_ZH_CN_RELIC_OVERLAY__) return;
  window.__ALECAFRAME_ZH_CN_RELIC_OVERLAY__ = true;

  const latestRewardEndpoint = "http://127.0.0.1:38147/latest-reward";
  const languageError = "unsupported warframe language detected";
  const staticRewardDucats = window.__ALECAFRAME_ZH_CN_REWARD_DUCATS__ || {};
  let recoveryStarted = false;
  let lastObservedState = "";
  let nativeRewardCaptureRequested = false;
  let priceInterfaceAudited = false;
  let rewardPriceQueryKey = "";
  let rewardPriceQueryPromise = null;
  let rewardPriceAppliedKey = "";
  let accountDataQueryKey = "";
  let accountDataQueryPromise = null;
  let accountDataAppliedKey = "";
  let accountTotalsQueryKey = "";
  let latestRewardPollInFlight = false;
  let accountTotalsDiagnosticStarted = false;
  let accountTotals = null;

  function audit(event, detail) {
    fetch("http://127.0.0.1:38147/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: event, detail: detail || "" })
    }).catch(() => { });
  }

  function displayName(englishName) {
    const translations = window.__ALECAFRAME_ZH_CN_ITEMS__ || {};
    const chineseName = translations[englishName];
    if (chineseName && chineseName !== englishName) return chineseName;
    // Forma Blueprint is a standalone reward whose native English name is not
    // present in every version of the external item table.
    return englishName === "Forma Blueprint" ? "Forma 蓝图" : englishName;
  }

  function enforceChineseRewardNames(names) {
    const app = window.relicsApp;
    if (!app || !Array.isArray(app.relics)) return;
    app.relics.forEach((relic, index) => {
      // The initial fallback in main.js creates plain reward objects before
      // this page script is loaded. The OCR result order is the card order,
      // so restore the internal English key here before each reactive update.
      const englishName = String(relic?.__zhRewardEnglishName || names?.[index] || "");
      if (!englishName) return;
      relic.__zhRewardEnglishName = englishName;
      relic.name = displayName(englishName);
    });
  }

  function makeReward(name, priceData, accountState) {
    const state = accountState || {};
    const price = priceData || {};
    return {
      name: displayName(name),
      __zhRewardEnglishName: name,
      platinum: Number.isFinite(Number(price.platinum)) ? Number(price.platinum) : -1,
      // The official reward overlay obtains this static value together with
      // the reward price. Fall back to inventory only for compatibility with
      // older native payloads that omit it.
      ducats: Number.isFinite(Number(price.ducats)) ? Number(price.ducats) :
        (Number.isFinite(Number(state.ducats)) ? Number(state.ducats) :
          (Number.isFinite(Number(staticRewardDucats[name])) ? Number(staticRewardDucats[name]) : -1)),
      isItemVaulted: false,
      isFav: !!state.isFav,
      isPartOfOwned: !!state.isPartOfOwned,
      countOwned: state.countOwned ?? "-",
      totalToOwn: state.totalToOwn ?? "-",
      componentData: Array.isArray(state.componentData) ? state.componentData : [],
      setPlat: -1,
      detected: true
    };
  }

  // This reward-window path is intentionally self-contained. The official
  // main.js helper can run before a cross-window reference is ready; asking
  // again from the loaded reward page makes the bridge handoff observable and
  // does not interact with the relic-planner recommendation overlay.
  function requestNativeRewardCapture() {
    if (nativeRewardCaptureRequested) return;
    nativeRewardCaptureRequested = true;
    audit("RELIC_OVERLAY_NATIVE_REQUEST_STARTED");
    try {
      if (!window.overwolf || !overwolf.windows ||
          typeof overwolf.windows.getMainWindow !== "function") {
        audit("RELIC_OVERLAY_NATIVE_REQUEST_UNAVAILABLE", "getMainWindow is unavailable");
        return;
      }
      const mainWindow = overwolf.windows.getMainWindow();
      const background = mainWindow && mainWindow.window ? mainWindow.window : mainWindow;
      audit("RELIC_OVERLAY_NATIVE_REQUEST_MAIN_WINDOW", JSON.stringify({
        type: typeof mainWindow,
        hasWindow: !!(mainWindow && mainWindow.window),
        hasBridge: !!(background &&
          typeof background.__ALECAFRAME_ZH_CN_CAPTURE_REWARD__ === "function")
      }));
      if (background && typeof background.__ALECAFRAME_ZH_CN_CAPTURE_REWARD__ === "function") {
        audit("RELIC_OVERLAY_NATIVE_REQUEST_BRIDGE_READY");
        background.__ALECAFRAME_ZH_CN_CAPTURE_REWARD__();
        return;
      }
      audit("RELIC_OVERLAY_NATIVE_REQUEST_BRIDGE_MISSING", String(!!background));
    } catch (error) {
      audit("RELIC_OVERLAY_NATIVE_REQUEST_FAILED", String(error && error.message || error));
    }
  }

  function readLatestRewards() {
    return fetch(latestRewardEndpoint)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error("No current reward OCR data")))
      .then((data) => Array.isArray(data && data.rewards) ? data.rewards : Promise.reject(new Error("No current reward OCR data")));
  }

  function queryPrices(names) {
    return new Promise((resolve) => {
      try {
        const nativePlugin = window.plugin && window.plugin.get && window.plugin.get();
        if (!nativePlugin || typeof nativePlugin.getHugePriceList !== "function") {
          if (!priceInterfaceAudited) {
            priceInterfaceAudited = true;
            audit("REWARD_PRICE_INTERFACE_UNAVAILABLE", JSON.stringify({
              hasPlugin: !!nativePlugin,
              hasMethod: !!(nativePlugin && nativePlugin.getHugePriceList)
            }));
          }
          resolve({});
          return;
        }
        const requestedAt = Date.now();
        nativePlugin.getHugePriceList(JSON.stringify(names), (success, data) => {
          if (!priceInterfaceAudited) {
            priceInterfaceAudited = true;
            let parsed = null;
            let parseError = "";
            try {
              parsed = JSON.parse(data);
            } catch (error) {
              parseError = String(error && error.message || error);
            }
            audit("REWARD_PRICE_INTERFACE_RESULT", JSON.stringify({
              success: !!success,
              durationMs: Date.now() - requestedAt,
              dataType: typeof data,
              raw: String(data || "").slice(0, 1600),
              parsedType: Array.isArray(parsed) ? "array" : typeof parsed,
              parsedKeys: parsed && !Array.isArray(parsed) ? Object.keys(parsed).slice(0, 30) : [],
              itemKeys: Array.isArray(parsed) ? parsed.slice(0, 4).map((item) => item && typeof item === "object" ? Object.keys(item) : typeof item) : [],
              parseError: parseError
            }));
          }
          if (!success) {
            resolve({});
            return;
          }
          try {
            const prices = JSON.parse(data);
            const byName = {};
            names.forEach((name, index) => {
              const item = prices[index] || {};
              // "post" is the sell price used by Aleca's relic detail UI.
              // The same native item payload is the only data source queried
              // by name, so it is also the correct account-independent place
              // to take a reward's static Ducat value when exposed.
              byName[name] = {
                platinum: item.post,
                ducats: item.ducats ?? item.ducat ?? item.ducatValue
              };
            });
            resolve(byName);
          } catch {
            resolve({});
          }
        });
      } catch {
        resolve({});
      }
    });
  }

  function applyRewardPriceData(names, prices) {
    const app = window.relicsApp;
    if (!app || !Array.isArray(app.relics) || app.relics.length !== names.length) return false;
    app.relics = app.relics.map((relic, index) => {
      const price = prices[names[index]] || {};
      const platinum = Number(price.platinum);
      const ducats = Number(price.ducats);
      const staticDucats = Number(staticRewardDucats[names[index]]);
      return {
        ...relic,
        platinum: Number.isFinite(platinum) ? platinum : relic.platinum,
        ducats: Number.isFinite(ducats) ? ducats :
          (Number.isFinite(staticDucats) ? staticDucats : relic.ducats)
      };
    });
    enforceChineseRewardNames(names);
    return true;
  }

  function loadRewardPriceData(names) {
    const key = [...new Set(names)].sort().join("|");
    if (!key) return Promise.resolve({});
    if (key === rewardPriceQueryKey && rewardPriceQueryPromise) {
      return rewardPriceQueryPromise.then((prices) => {
        if (rewardPriceAppliedKey !== key && applyRewardPriceData(names, prices)) {
          rewardPriceAppliedKey = key;
        }
        return prices;
      });
    }
    rewardPriceQueryKey = key;
    rewardPriceAppliedKey = "";
    rewardPriceQueryPromise = queryPrices(names).then((prices) => {
      audit("REWARD_PRICE_DATA_READY", JSON.stringify({
        key: key,
        ducatCount: names.filter((name) => Number.isFinite(Number(prices[name]?.ducats))).length
      }));
      if (applyRewardPriceData(names, prices)) rewardPriceAppliedKey = key;
      return prices;
    });
    return rewardPriceQueryPromise;
  }

  function parseNativeJson(data) {
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  function requestNativeItems(nativePlugin, methodName, filterSettings) {
    return new Promise((resolve) => {
      try {
        nativePlugin[methodName](JSON.stringify(filterSettings), true, (success, data) => {
          const parsed = success ? parseNativeJson(data) : null;
          resolve(Array.isArray(parsed) ? parsed : []);
        });
      } catch (error) {
        audit("REWARD_ACCOUNT_" + methodName + "_FAILED", String(error?.message || error));
        resolve([]);
      }
    });
  }

  // Chinese-game recognition prevents GetRelicWindowData from supplying its
  // normal globalData object. The native foundry player-stat payload is
  // language-independent and has been verified to expose real account
  // balances as "platinum" and Aleca's historical "ducados" field.
  function applyAccountTotals() {
    const app = window.relicsApp;
    if (!app || !accountTotals) return false;
    if (!app.globalData || typeof app.globalData !== "object") {
      app.globalData = { platinum: -1, ducats: -1 };
    }
    // Update Vue's existing reactive object instead of replacing it. The
    // language-recovery path also recreates this object after OCR completes.
    app.globalData.platinum = accountTotals.platinum;
    app.globalData.ducats = accountTotals.ducats;
    audit("REWARD_ACCOUNT_TOTALS_APPLIED", JSON.stringify(app.globalData));
    setTimeout(() => {
      audit("REWARD_ACCOUNT_TOTALS_AFTER_DELAY", JSON.stringify(app.globalData));
    }, 150);
    return true;
  }

  function loadAccountTotals() {
    const nativePlugin = window.plugin?.get?.();
    if (!nativePlugin?.getFoundryPlayerStats || accountTotalsDiagnosticStarted) return;
    accountTotalsDiagnosticStarted = true;
    try {
      nativePlugin.getFoundryPlayerStats((success, data) => {
        const payload = success ? parseNativeJson(data) : null;
        const platinum = Number(payload?.platinum);
        const ducats = Number(payload?.ducados);
        if (!payload?.dataReady || !Number.isFinite(platinum) || !Number.isFinite(ducats)) {
          audit("REWARD_ACCOUNT_TOTALS_UNAVAILABLE", JSON.stringify({
            success: !!success,
            dataReady: !!payload?.dataReady,
            keys: payload && typeof payload === "object" ? Object.keys(payload) : []
          }));
          return;
        }
        accountTotals = { platinum: platinum, ducats: ducats };
        applyAccountTotals();
        audit("REWARD_ACCOUNT_TOTALS", JSON.stringify({ platinum: platinum, ducats: ducats }));
      });
    } catch (error) {
      audit("REWARD_ACCOUNT_TOTALS_FAILED", String(error?.message || error));
    }
  }

  function inventoryFilter(name, type) {
    return {
      type: type, search: name, order: "name", orderLargerToSmaller: false,
      yesnoFilters: "{}", onlyOwned: false
    };
  }

  function foundryFilter(name) {
    return {
      type: "all", search: name, order: "name", prime: "all",
      orderLargerToSmaller: false, yesnoFilters: "{}"
    };
  }

  function rewardBelongsToFoundryParent(rewardName, parentName) {
    if (!rewardName || !parentName) return false;
    const reward = String(rewardName).toLowerCase();
    const parent = String(parentName).toLowerCase();
    return reward === parent || reward.startsWith(parent + " ");
  }

  // Account state is resolved only through Aleca's native inventory and
  // Foundry interfaces. In particular, the reward-screen badges are not a
  // source of truth: they describe the game card, not this account's data.
  async function queryRewardAccountState(nativePlugin, name) {
    const [partInventory, foundryItems] = await Promise.all([
      requestNativeItems(nativePlugin, "getFilteredInventory", inventoryFilter(name, "allParts")),
      requestNativeItems(nativePlugin, "getFilteredFoundry", foundryFilter(name))
    ]);
    let inventoryItem = partInventory.find((item) => item?.name === name);
    if (!inventoryItem) {
      const allInventory = await requestNativeItems(nativePlugin, "getFilteredInventory", inventoryFilter(name, "all"));
      inventoryItem = allInventory.find((item) => item?.name === name);
    }

    // Foundry search is fuzzy. A generic component such as "Forma Blueprint"
    // occurs in unrelated recipes, so an exact component match alone is not
    // enough: its reward name must also belong to that recipe's parent item.
    let parent = null;
    let component = null;
    for (const item of foundryItems) {
      const matchingComponent = Array.isArray(item?.components)
        ? item.components.find((candidate) => candidate?.name === name)
        : null;
      if (matchingComponent && rewardBelongsToFoundryParent(name, item?.name)) {
        parent = item;
        component = matchingComponent;
        break;
      }
    }

    const inventoryCount = inventoryItem?.amountOwned;
    // Unowned rewards can be absent from the inventory list. Aleca exposes
    // the same static Ducat value on the matching Foundry component.
    const ducats = inventoryItem?.ducats ?? component?.ducats;
    const componentCount = component?.quantityOwned;
    const componentNeed = component?.neccessaryAmount;
    const countOwned = componentCount ?? inventoryCount;
    const totalToOwn = componentNeed ?? (inventoryItem ? 1 : "-");
    const state = {
      isFav: !!(component?.isFav || component?.isFavOnlyPart || inventoryItem?.isFav || parent?.isFav),
      isPartOfOwned: !!parent?.owned,
      ducats: Number.isFinite(Number(ducats)) ? Number(ducats) : -1,
      countOwned: countOwned === undefined || countOwned === null ? "-" : String(countOwned),
      totalToOwn: totalToOwn === undefined || totalToOwn === null ? "-" : String(totalToOwn),
      componentData: Array.isArray(parent?.components) ? parent.components : []
    };
    audit("REWARD_ACCOUNT_STATE", JSON.stringify({
      reward: name,
      inventoryExact: !!inventoryItem,
      foundryParent: parent?.name || "",
      foundryComponent: component?.name || "",
      isPartOfOwned: state.isPartOfOwned,
      ducats: state.ducats,
      inventoryDucats: inventoryItem?.ducats,
      componentDucats: component?.ducats,
      inventoryKeys: inventoryItem ? Object.keys(inventoryItem).sort() : [],
      componentKeys: component ? Object.keys(component).sort() : [],
      countOwned: state.countOwned,
      totalToOwn: state.totalToOwn,
      componentCount: state.componentData.length
    }));
    return state;
  }

  function applyAccountStates(names, states) {
    const app = window.relicsApp;
    if (!app || !Array.isArray(app.relics) || app.relics.length !== names.length) return false;
    app.relics = app.relics.map((relic, index) => {
      const state = states[names[index]] || {};
      const staticDucats = Number(staticRewardDucats[names[index]]);
      return {
        ...relic,
        ...state,
        // Native inventory data is account-specific and wins when available.
        // The bundled static index covers unowned components omitted there.
        ducats: Number.isFinite(Number(state.ducats)) && Number(state.ducats) >= 0
          ? Number(state.ducats)
          : (Number.isFinite(staticDucats) ? staticDucats : relic.ducats)
      };
    });
    enforceChineseRewardNames(names);
    return true;
  }

  function loadAccountStates(names) {
    const key = [...new Set(names)].sort().join("|");
    if (!key) return Promise.resolve({});
    if (key === accountDataQueryKey && accountDataQueryPromise) {
      return accountDataQueryPromise.then((states) => {
        if (accountDataAppliedKey !== key && applyAccountStates(names, states)) {
          accountDataAppliedKey = key;
        }
        return states;
      });
    }
    const nativePlugin = window.plugin?.get?.();
    if (!nativePlugin?.getFilteredInventory || !nativePlugin?.getFilteredFoundry) {
      audit("REWARD_ACCOUNT_INTERFACE_UNAVAILABLE");
      return Promise.resolve({});
    }
    accountDataQueryKey = key;
    accountDataAppliedKey = "";
    const startedAt = Date.now();
    accountDataQueryPromise = Promise.all(names.map(async (name) => [name, await queryRewardAccountState(nativePlugin, name)]))
      .then((entries) => {
        const states = Object.fromEntries(entries);
        audit("REWARD_ACCOUNT_STATE_READY", JSON.stringify({ key: key, durationMs: Date.now() - startedAt }));
        if (applyAccountStates(names, states)) {
          accountDataAppliedKey = key;
        }
        return states;
      })
      .catch((error) => {
        audit("REWARD_ACCOUNT_STATE_FAILED", String(error?.message || error));
        return {};
      });
    return accountDataQueryPromise;
  }

  function pollRewardAccountState() {
    if (latestRewardPollInFlight) return;
    latestRewardPollInFlight = true;
    readLatestRewards()
      .then((names) => {
        // main.js can create its initial fallback cards before this script
        // gets a chance to tag them. Keep their display value Chinese-only
        // while retaining the English name privately for native API calls.
        enforceChineseRewardNames(names);
        const key = [...new Set(names)].sort().join("|");
        if (key && key !== accountTotalsQueryKey) {
          accountTotalsQueryKey = key;
          loadAccountTotals();
        }
        return Promise.all([loadRewardPriceData(names), loadAccountStates(names)]);
      })
      .catch(() => { })
      .finally(() => { latestRewardPollInFlight = false; });
  }

  function recoverLanguageError() {
    const app = window.relicsApp;
    const errorMessage = app ? String(app.errorMessage || "") : "";
    const state = JSON.stringify({
      app: !!app,
      error: !!(app && app.error),
      loading: !!(app && app.loading),
      languageError: errorMessage.toLowerCase().includes(languageError),
      message: errorMessage.slice(0, 180)
    });
    if (state !== lastObservedState) {
      lastObservedState = state;
      audit("RELIC_OVERLAY_STATE", state);
    }
    if (recoveryStarted || !app || !app.error ||
        !errorMessage.toLowerCase().includes(languageError)) {
      return;
    }
    recoveryStarted = true;
    audit("RELIC_OVERLAY_LANGUAGE_FALLBACK_STARTED");

    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      readLatestRewards().then((names) => {
        if (names.length === 0) throw new Error("No rewards");
        clearInterval(timer);
        return queryPrices(names).then((prices) => {
          relicsApp.relics = names.map((name) => makeReward(name, prices[name]));
          relicsApp.globalData = { platinum: -1, ducats: -1 };
          relicsApp.error = false;
          relicsApp.errorMessage = "";
          relicsApp.loading = false;
          // The native reward callback can write its language error after the
          // first successful recovery. Allow the observer to apply the same
          // current reward list again if that delayed write occurs.
          recoveryStarted = false;
          audit("RELIC_OVERLAY_LANGUAGE_FALLBACK_READY", names.join(" | "));
          loadAccountTotals();
          applyAccountTotals();
          loadAccountStates(names);
        });
      }).catch(() => {
        // OCR and the native window open race each other. Retry briefly, but
        // never replace a real error with a stale or empty reward list.
        // A full Chinese reward OCR pass can take about five seconds on an
        // ultrawide frame. Keep polling long enough for that result while the
        // game reward-selection timer is still active.
        if (attempts >= 70) {
          clearInterval(timer);
          recoveryStarted = false;
          audit("RELIC_OVERLAY_LANGUAGE_FALLBACK_TIMEOUT");
        }
      });
    }, 180);
  }

  audit("RELIC_OVERLAY_SCRIPT_LOADED");
  requestNativeRewardCapture();
  // The official page can clear its language-error flag before the OCR
  // result returns. Account lookup must therefore be triggered by the
  // published reward result itself, not by the UI error state.
  setInterval(pollRewardAccountState, 220);
  setInterval(recoverLanguageError, 80);
})();
