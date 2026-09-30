(function () {
  "use strict";

  if (window.__ALECAFRAME_ZH_CN_RIVEN_OVERLAY__) return;
  window.__ALECAFRAME_ZH_CN_RIVEN_OVERLAY__ = true;

  // Chinese four-stat quote cards need four visible text rows. This scopes the
  // height adjustment to native similar-riven cards; the original scroll list,
  // overlay layout, and all OCR/native data paths remain unchanged.
  function installSimilarRivenFourStatStyle() {
    if (document.getElementById("alecaframe-zh-cn-riven-four-stat-style")) return;
    const style = document.createElement("style");
    style.id = "alecaframe-zh-cn-riven-four-stat-style";
    style.textContent = [
      ".rivenOverlayExternal .similarRiven { height: 128px; }",
      ".rivenOverlayExternal .similarRiven .similarBody { overflow-y: auto; overscroll-behavior: contain; }",
      ".rivenOverlayExternal .similarRiven .similarRivenAttr { white-space: normal; overflow-wrap: anywhere; line-height: 14px; min-height: 14px; }"
    ].join("\n");
    document.head.appendChild(style);
  }
  const resultKey = "__alecaframeZhCnRivenOverlayResult";
  const activeKey = "__alecaframeZhCnRivenOverlayActive";
  const chatResultKey = "__alecaframeZhCnRivenChatOverlayResult";
  const chatActiveKey = "__alecaframeZhCnRivenChatOverlayActive";
  const maxAgeMs = 5000;
  const nativeDiagnosticEndpoint = "http://127.0.0.1:38147/audit-riven-native";
  const nativeGradeDiagnostics = Object.create(null);
  const nativeHistoryDiagnostics = Object.create(null);
  let lastChatNativeRaw = "";
  let lastChatNativeProbeAt = 0;
  let chatNativeHookInstalled = false;

  const nativeTraitIds = {
    "暴击伤害": "WeaponCritDamageMod",
    "暴击几率": "WeaponCritChanceMod",
    "暴击": "WeaponCritChanceMod",
    "伤害": "WeaponDamageAmountMod",
    "多重射击": "WeaponFireIterationsMod",
    "多重身": "WeaponFireIterationsMod",
    "弹匣容量": "WeaponClipMaxMod",
    "弹匣": "WeaponClipMaxMod",
    "穿透": "WeaponPunctureDepthMod",
    "射速": "WeaponFireRateMod",
    "触发几率": "WeaponStunChanceMod",
    "触发": "WeaponStunChanceMod",
    "飞行速度": "WeaponProjectileSpeedMod",
    "装填速度": "WeaponReloadSpeedMod",
    "攻击速度": "WeaponMeleeAttackSpeedMod",
    "范围": "WeaponMeleeRangeMod",
    "初始连击": "WeaponMeleeInitialComboMod",
    "毒素伤害": "WeaponToxinDamageMod",
    "触发时间": "WeaponProcTimeMod",
    "武器后坐力": "WeaponRecoilReductionMod",
    "后坐力": "WeaponRecoilReductionMod",
    "冲击伤害": "WeaponImpactDamageMod",
    "穿刺伤害": "WeaponArmorPiercingDamageMod",
    "切割伤害": "WeaponSlashDamageMod",
    "火焰伤害": "WeaponFireDamageMod",
    "寒冷伤害": "WeaponFreezeDamageMod",
    "冰冻伤害": "WeaponFreezeDamageMod",
    "电击伤害": "WeaponElectricityDamageMod",
    "最大弹药量": "WeaponAmmoMaxMod",
    "弹药上限": "WeaponAmmoMaxMod",
    "瞄准倍率": "WeaponZoomFovMod",
    "瞄准缩放": "WeaponZoomFovMod",
    "缩放": "WeaponZoomFovMod",
    "滑行暴击几率": "WeaponCritChanceSPMod",
    "滑行暴击": "WeaponCritChanceSPMod",
    "重击效率": "WeaponHeavyAttackEfficiencySPMod",
    "近战触发几率": "WeaponMeleeStatusChanceSPMod",
    "近战触发": "WeaponMeleeStatusChanceSPMod",
    "爆头暴击几率": "WeaponWeakpointCriticalChanceMod",
    "弱点暴击几率": "WeaponWeakpointCriticalChanceMod",
    "处决伤害": "WeaponMeleeStealthLethalMod",
    "终结伤害": "WeaponMeleeStealthLethalMod",
    "重击伤害": "WeaponMeleeSlamDamageMod",
    "下砸伤害": "WeaponMeleeSlamDamageMod",
    "光束距离": "WeaponBeamDistanceRifleMod",
    "射线距离": "WeaponBeamDistanceRifleMod",
    "自伤减免": "WeaponResistSelfDamageMod",
    "对Grineer伤害": "WeaponFactionDamageGrineer",
    "对Corpus伤害": "WeaponFactionDamageCorpus",
    "对Infested伤害": "WeaponFactionDamageInfested"
  };

  function getNativeRivenWeaponId(weaponName) {
    const raw = String(weaponName || "").trim();
    if (!raw) return "";
    // The OCR bridge maps the Chinese display name to a Warframe item name
    // (for example 沙皇 -> Zarr).  GetRivenHistoryData instead expects the
    // riven service's internal uniqueID.  Resolve it through AlecaFrame's own
    // GetRivenWeapons result, then keep the returned uniqueID untouched.
    return raw;
  }

  function postNativeDiagnostic(payload) {
    fetch(nativeDiagnosticEndpoint, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
    }).catch(function () { });
  }

  // The native overlay OCR payload is unavailable in a Chinese game client,
  // so inspect the already-used history response once per weapon instead.  It
  // is diagnostic-only and never participates in rendering or requests.
  function collectNativeHistoryGradeDiagnostic(nativeWeaponId, weaponName, history) {
    const key = String(nativeWeaponId || "");
    if (!key || nativeHistoryDiagnostics[key]) return;
    nativeHistoryDiagnostics[key] = true;
    let raw = "";
    try { raw = JSON.stringify(history || {}); } catch (error) { raw = ""; }
    postNativeDiagnostic({
      capturedAt: Date.now(),
      phase: "history-grade-readonly",
      nativeWeaponId: key,
      weaponName: String(weaponName || ""),
      historyRaw: raw.slice(0, 500000)
    });
  }

  // Do not use this raw payload for rendering: English OCR may be unavailable
  // in the Chinese client.  It is captured once per stable card only to locate
  // AlecaFrame's exact native grade/rawRandomValue fields.
  function collectExactNativeGradeDiagnostic(nativePlugin, nativeWeaponId, card, finder) {
    const key = nativeCardIdentity(nativeWeaponId, card);
    if (nativeGradeDiagnostics[key] || !nativePlugin || typeof nativePlugin.GetRivenOverlayData !== "function") return;
    nativeGradeDiagnostics[key] = true;
    try {
      nativePlugin.GetRivenOverlayData(function (success, raw) {
        postNativeDiagnostic({
          capturedAt: Date.now(), phase: "exact-grade-readonly", nativeWeaponId: nativeWeaponId,
          cardIdentity: cardVisualIdentity(card), surname: card.rivenSurname || card.rivenName || "",
          ocrTraits: (card.traits || []).filter(displayableTrait),
          finderAttrs: finder.attrs,
          nativeOverlaySuccess: !!success, nativeOverlayRaw: String(raw || "").slice(0, 200000)
        });
      });
    } catch (error) {
      postNativeDiagnostic({ capturedAt: Date.now(), phase: "exact-grade-readonly", nativeWeaponId: nativeWeaponId, cardIdentity: cardVisualIdentity(card), error: String(error && error.message || error) });
    }
  }

  // A chat-linked riven is a native one-card overlay, unlike the Chinese OCR
  // reroll comparison which always publishes a complete pair.  Capture the
  // native response verbatim before deciding how to render it.  This is
  // strictly read-only: it neither changes app.data nor the existing pair
  // payload/cache, so the already-stable reroll overlay cannot be affected.
  function collectChatNativeDiagnostic(nativePlugin, source) {
    if (!nativePlugin || typeof nativePlugin.GetRivenOverlayData !== "function") return;
    const now = Date.now();
    if (now - lastChatNativeProbeAt < 300) return;
    lastChatNativeProbeAt = now;
    try {
      nativePlugin.GetRivenOverlayData(function (success, raw) {
        const rawText = String(raw || "");
        const data = success ? parseNativeJson(rawText) : null;
          const left = data && data.rivenLeft;
          const right = data && data.rivenRight;
          const leftVisible = !!(left && left.show && left.data);
          const rightVisible = !!(right && right.show && right.data);
          // Read the first distinct native reply verbatim even when Chinese UI
          // makes the native English OCR report disabled or empty.  This is a
          // diagnostic only: it cannot change the independent reroll path.
          if (rawText === lastChatNativeRaw) return;
          lastChatNativeRaw = rawText;
          const classification = !success ? "native-call-failed"
            : !data ? "invalid-or-empty-json"
            : !data.enabled ? "disabled-or-empty"
            : leftVisible && !rightVisible ? "single-left"
            : rightVisible && !leftVisible ? "single-right"
            : leftVisible && rightVisible ? "two-cards-reroll"
            : "enabled-without-visible-card";
          postNativeDiagnostic({
            capturedAt: Date.now(),
            phase: "chat-native-readonly",
            source: String(source || "refresh"),
            classification: classification,
            enabled: !!(data && data.enabled),
            leftVisible: leftVisible,
            rightVisible: rightVisible,
            visibleSide: leftVisible && !rightVisible ? "left" : rightVisible && !leftVisible ? "right" : null,
            nativeOverlaySuccess: !!success,
            nativeOverlayRaw: rawText.slice(0, 500000)
          });
      });
    } catch (error) {
      postNativeDiagnostic({ capturedAt: Date.now(), phase: "chat-native-readonly", source: String(source || "refresh"), error: String(error && error.message || error) });
    }
  }

  // The original page registers its listener before this add-on is loaded.
  // Wrapping refresh therefore misses a chat link when the native listener
  // synchronously closes the overlay after returning enabled:false.  Attach an
  // additional, read-only listener directly to the same event instead.
  function installChatNativeEventDiagnostic() {
    if (chatNativeHookInstalled) return;
    const nativePlugin = window.plugin && typeof window.plugin.get === "function" ? window.plugin.get() : null;
    const event = nativePlugin && nativePlugin.onRivenOverlayChange;
    if (!event || typeof event.addListener !== "function") return;
    try {
      event.addListener(function () {
        // Let the native event update its OCR state first, then sample its
        // response.  The callback is diagnostic-only and never renders data.
        setTimeout(function () { collectChatNativeDiagnostic(nativePlugin, "native-overlay-change"); }, 80);
        setTimeout(function () { collectChatNativeDiagnostic(nativePlugin, "native-overlay-change-settled"); }, 550);
      });
      chatNativeHookInstalled = true;
    } catch (error) {
      postNativeDiagnostic({ capturedAt: Date.now(), phase: "chat-native-readonly", source: "native-overlay-change-install", error: String(error && error.message || error) });
    }
  }

  function canonicalNativeTraitName(text) {
    const value = String(text || "").replace(/\s+/g, "");
    if (/^弹(?:匣(?:容|容量)?|厘|便容量?)/.test(value)) return "弹匣容量";
    if (/^多重/.test(value)) return "多重射击";
    if (/^穿透$/.test(value)) return "穿透";
    if (/^暴击伤害?$/.test(value)) return "暴击伤害";
    if (/^暴击(?:几|几率)?$/.test(value)) return "暴击几率";
    if (/^射速(?:（.*)?$/.test(value)) return "射速";
    if (/^触发时间/.test(value)) return "触发时间";
    if (/^触发/.test(value)) return "触发几率";
    if (/^装填/.test(value)) return "装填速度";
    if (/^毒素伤害/.test(value)) return "毒素伤害";
    if (/^(?:火焰|火)伤害/.test(value)) return "火焰伤害";
    if (/^(?:寒冷|冰冻|冰)伤害/.test(value)) return "寒冷伤害";
    if (/^(?:电击|电)伤害/.test(value)) return "电击伤害";
    if (/^(?:穿刺|穿透)伤害/.test(value)) return "穿刺伤害";
    if (/^(?:切割|斩击)伤害/.test(value)) return "切割伤害";
    if (/^[入>]?冲击伤害/.test(value)) return "冲击伤害";
    if (/^(?:最大)?弹药(?:量|上限)?/.test(value)) return "最大弹药量";
    if (/^(?:瞄准倍率|瞄准缩放|缩放)/.test(value)) return "瞄准倍率";
    if (/^滑行暴击(?:几率)?/.test(value)) return "滑行暴击几率";
    if (/^重击效率/.test(value)) return "重击效率";
    if (/^近战触发(?:几率)?/.test(value)) return "近战触发几率";
    if (/^(?:爆头|弱点)暴击(?:几率)?/.test(value)) return "爆头暴击几率";
    if (/^(?:处决|终结)伤害/.test(value)) return "处决伤害";
    if (/^(?:重击|下砸)伤害/.test(value)) return "重击伤害";
    if (/^(?:光束|射线)距离/.test(value)) return "光束距离";
    if (/^自伤减免/.test(value)) return "自伤减免";
    if (/^(?:武器)?后坐力/.test(value)) return "武器后坐力";
    if (/^对Grineer(?:的)?伤害/i.test(value)) return "对Grineer伤害";
    if (/^对Corpus(?:的)?伤害/i.test(value)) return "对Corpus伤害";
    if (/^对Infested(?:的)?伤害/i.test(value)) return "对Infested伤害";
    return value;
  }

  function buildNativeFinderAttrs(cards, nativeAttrs) {
    const allowed = new Set((nativeAttrs || []).map(function (attr) { return String(attr && attr.internalName || ""); }));
    const observed = [];
    (cards || []).forEach(function (card) {
      (card && card.traits || []).forEach(function (trait) {
        if (!trait || (trait.sign !== "+" && trait.sign !== "-")) return;
        const traitId = nativeTraitIds[canonicalNativeTraitName(trait.text)];
        if (!traitId || !allowed.has(traitId)) return;
        observed.push({ positive: trait.sign === "+", selectedAttrUID: traitId, required: false });
      });
    });
    const seen = Object.create(null);
    const positive = observed.filter(function (attr) {
      if (!attr.positive || seen["+" + attr.selectedAttrUID]) return false;
      seen["+" + attr.selectedAttrUID] = true;
      return true;
    }).slice(0, 3);
    const negative = observed.filter(function (attr) {
      if (attr.positive || seen["-" + attr.selectedAttrUID]) return false;
      seen["-" + attr.selectedAttrUID] = true;
      return true;
    }).slice(0, 1);
    while (positive.length < 3) positive.push({ positive: true, selectedAttrUID: "", required: false });
    while (negative.length < 1) negative.push({ positive: false, selectedAttrUID: "", required: false });
    return positive.concat(negative);
  }

  // Native results are cached by the immutable card identity, never by left/right
  // screen position.  This prevents a delayed request for one card from being
  // painted into the other card after the player changes selection.
  const nativeCardCache = Object.create(null);
  const nativeWeaponCache = Object.create(null);
  let nativeRequestVersion = 0;

  function parseNativeJson(data) {
    try { return data ? JSON.parse(data) : null; } catch (error) { return null; }
  }

  function cardVisualIdentity(card) {
    const traits = (card && card.traits || []).filter(displayableTrait).map(function (trait) {
      return [trait.sign, trait.value, trait.unit, canonicalNativeTraitName(trait.text)].join(":");
    }).sort().join("|");
    return [String(card && (card.rivenSurname || card.rivenName) || "").toLowerCase(), traits].join("::");
  }

  function nativeCardIdentity(nativeWeaponId, card) {
    return [nativeWeaponId, cardVisualIdentity(card)].join("::");
  }

  function finderFilters() {
    return { minPrice: 0, maxPrice: 10000000, minSimilarity: 0, minRerolls: 0, maxRerolls: 10000000, negativeRequired: false };
  }

  function invokeNativeFinder(nativePlugin, nativeWeaponId, card, history, done) {
    const attrsToSelect = buildNativeFinderAttrs([card], history.attrs);
    let attrs = null, similarRivens = null, pending = 2;
    const complete = function () {
      if (--pending !== 0) return;
      done({ attrs: Array.isArray(attrs) ? attrs : [], similarRivens: Array.isArray(similarRivens) ? similarRivens : [] });
    };
    try {
      nativePlugin.FinderRivenAttrsJustChanged(nativeWeaponId, JSON.stringify(attrsToSelect), JSON.stringify(finderFilters()), function (success, data) {
        attrs = success ? parseNativeJson(data) : [];
        complete();
      }, function (success, data) {
        similarRivens = success ? parseNativeJson(data) : [];
        complete();
      });
    } catch (error) { done({ attrs: [], similarRivens: [] }); }
  }

  function cachedNativeForCard(card) {
    const visualKey = cardVisualIdentity(card);
    const key = Object.keys(nativeCardCache).find(function (candidate) {
      const record = nativeCardCache[candidate];
      return record && record.native && cardVisualIdentity(record.card) === visualKey;
    });
    return key ? nativeCardCache[key].native : null;
  }

  function currentCardDataByKey(key) {
    const app = window.rivenOverlayApp;
    if (!app || !app.data) return [];
    return [app.data.rivenLeft, app.data.rivenRight].filter(function (side) {
      return side && side.data && side.data.__zhNativeKey === key;
    });
  }

  function applyNativeCardData(key, native) {
    const cache = nativeCardCache[key];
    if (!cache) return;
    cache.native = native;
    const visualKey = cardVisualIdentity(cache.card);
    currentCardDataByKey(visualKey).forEach(function (side) {
      const original = cache.card;
      const payload = nativePayloadCard(original, key, native);
      // Preserve native page structure; only replace the already-visible card
      // content, without recreating either overlay half.
      Object.keys(payload).forEach(function (field) { side.data[field] = payload[field]; });
    });
  }

  function requestNativeCardData(nativePlugin, nativeWeaponId, card, history) {
    const key = nativeCardIdentity(nativeWeaponId, card);
    const existing = nativeCardCache[key];
    if (existing && (existing.pending || existing.native)) return;
    nativeCardCache[key] = { card: card, pending: true, native: null, requestVersion: ++nativeRequestVersion };
    const requestVersion = nativeCardCache[key].requestVersion;
    invokeNativeFinder(nativePlugin, nativeWeaponId, card, history, function (finder) {
      const record = nativeCardCache[key];
      if (!record || record.requestVersion !== requestVersion) return;
      record.pending = false;
      const native = {
        attrs: finder.attrs,
        similarRivens: finder.similarRivens,
        history: history,
        goodRollData: history.goodRollData && typeof history.goodRollData === "object"
          ? history.goodRollData : { goodAttrs: [], acceptedBadAttrs: [] }
      };
      collectExactNativeGradeDiagnostic(nativePlugin, nativeWeaponId, card, native);
      applyNativeCardData(key, native);
    });
  }

  function refreshNativeCardData(payload) {
    const parsed = payload && payload.parsed || {};
    const cards = Array.isArray(parsed.cards) ? parsed.cards.filter(function (card) {
      return card && card.rivenSurname && Array.isArray(card.traits) && card.traits.some(displayableTrait);
    }) : [];
    const weaponName = String((cards[0] || {}).weaponNameEnglishCandidate || parsed.weaponNameEnglishCandidate || "").trim();
    if (!weaponName || !cards.length) return;
    const nativePlugin = window.plugin && typeof window.plugin.get === "function" ? window.plugin.get() : null;
    if (!nativePlugin || typeof nativePlugin.GetRivenWeapons !== "function" || typeof nativePlugin.GetRivenHistoryData !== "function" || typeof nativePlugin.FinderRivenAttrsJustChanged !== "function") return;
    const subscriptionStatus = typeof window.getSubscriptionStatus === "function" ? String(window.getSubscriptionStatus() || "None") : "None";
    const cached = nativeWeaponCache[weaponName.toLowerCase()];
    const start = function (context) {
      cards.forEach(function (card) { requestNativeCardData(nativePlugin, context.nativeWeaponId, card, context.history); });
    };
    if (cached && cached.history && cached.nativeWeaponId) { start(cached); return; }
    nativePlugin.GetRivenWeapons(weaponName, function (searchSuccess, searchData) {
      const matches = parseNativeJson(searchData);
      const normalized = weaponName.toLowerCase();
      const match = (Array.isArray(matches) ? matches : []).find(function (item) {
        return String(item && item.name || "").toLowerCase() === normalized;
      }) || (Array.isArray(matches) ? matches : [])[0];
      const nativeWeaponId = String(match && match.uniqueID || "").trim();
      if (!searchSuccess || !nativeWeaponId) return;
      nativePlugin.GetRivenHistoryData(nativeWeaponId, subscriptionStatus, function (success, data) {
        const history = success ? parseNativeJson(data) : null;
        if (!history || !Array.isArray(history.attrs)) return;
        collectNativeHistoryGradeDiagnostic(nativeWeaponId, weaponName, history);
        const context = { nativeWeaponId: nativeWeaponId, history: history };
        nativeWeaponCache[weaponName.toLowerCase()] = context;
        start(context);
      });
    });
  }

  function readPayload() {
    try {
      // background.html and rivenOverlay.html do not share localStorage.
      // Overwolf exposes the background/main page directly to declared windows.
      const main = window.overwolf && overwolf.windows && typeof overwolf.windows.getMainWindow === "function"
        ? overwolf.windows.getMainWindow() : null;
      const payload = main && main.__ALECAFRAME_ZH_CN_RIVEN_RESULT__;
      const activeAt = Number(main && main.__ALECAFRAME_ZH_CN_RIVEN_ACTIVE_AT__ || 0);
      if (payload && activeAt && Date.now() - activeAt <= maxAgeMs && payload.parsed && payload.parsed.success) {
        return payload;
      }
      // Fallback for a future same-origin Overwolf storage implementation.
      const raw = localStorage.getItem(resultKey);
      const localActiveAt = Number(localStorage.getItem(activeKey) || 0);
      if (!raw || !localActiveAt || Date.now() - localActiveAt > maxAgeMs) return null;
      const localPayload = JSON.parse(raw);
      return localPayload && localPayload.parsed && localPayload.parsed.success ? localPayload : null;
    } catch (error) {
      return null;
    }
  }

  const rivenTraitNames = {
    "暴击伤害": "Critical Damage",
    "暴击几率": "Critical Chance",
    "暴击": "Critical Chance",
    "伤害": "Damage",
    "多重射击": "Multishot",
    "多重身": "Multishot",
    "弹匣容量": "Magazine Capacity",
    "弹匣": "Magazine Capacity",
    "穿透": "Punch Through",
    "射速": "Fire Rate",
    "触发几率": "Status Chance",
    "触发": "Status Chance",
    "范围": "Range",
    "飞行速度": "Projectile Speed",
    "装填速度": "Reload Speed",
    "攻击速度": "Attack Speed",
    "初始连击": "Initial Combo",
    "毒素伤害": "Toxin",
    "冲击伤害": "Impact",
    "穿刺伤害": "Puncture",
    "切割伤害": "Slash",
    "火焰伤害": "Heat",
    "寒冷伤害": "Cold",
    "冰冻伤害": "Cold",
    "电击伤害": "Electricity",
    "最大弹药量": "Maximum Ammo",
    "弹药上限": "Maximum Ammo",
    "瞄准倍率": "Zoom",
    "瞄准缩放": "Zoom",
    "缩放": "Zoom",
    "滑行暴击几率": "Slide Critical Chance",
    "滑行暴击": "Slide Critical Chance",
    "重击效率": "Heavy Attack Efficiency",
    "近战触发几率": "Melee Status Chance",
    "近战触发": "Melee Status Chance",
    "爆头暴击几率": "Headshot Critical Chance",
    "弱点暴击几率": "Headshot Critical Chance",
    "处决伤害": "Finisher Damage",
    "终结伤害": "Finisher Damage",
    "重击伤害": "Slam Attack Damage",
    "下砸伤害": "Slam Attack Damage",
    "光束距离": "Beam Length",
    "射线距离": "Beam Length",
    "自伤减免": "Self Damage Reduction",
    "触发时间": "Status Duration"
  };

  function canonicalDisplayTraitName(text) {
    const value = String(text || "").replace(/\s+/g, "");
    // The dim, unselected card is frequently clipped by Paddle.  These are
    // spelling fragments of the same stat, not distinct traits.
    if (/^弹(?:匣(?:容|容量)?|厘|便容量?)/.test(value)) return "弹匣容量";
    if (/^多重/.test(value)) return "多重射击";
    if (/^穿透$/.test(value)) return "穿透";
    if (/^暴击伤害?$/.test(value)) return "暴击伤害";
    if (/^暴击(?:几|几率)?$/.test(value)) return "暴击几率";
    if (/^伤害$/.test(value)) return "伤害";
    if (/^射速(?:（.*)?$/.test(value)) return "射速";
    if (/^触发时间/.test(value)) return "触发时间";
    if (/^触发/.test(value)) return "触发几率";
    if (/^装填/.test(value)) return "装填速度";
    if (/^毒素伤害/.test(value)) return "毒素伤害";
    if (/^(?:火焰|火)伤害/.test(value)) return "火焰伤害";
    if (/^(?:寒冷|冰冻|冰)伤害/.test(value)) return "寒冷伤害";
    if (/^(?:电击|电)伤害/.test(value)) return "电击伤害";
    if (/^(?:穿刺|穿透)伤害/.test(value)) return "穿刺伤害";
    if (/^(?:切割|斩击)伤害/.test(value)) return "切割伤害";
    if (/^[入>]?冲击伤害/.test(value)) return "冲击伤害";
    if (/^(?:最大)?弹药(?:量|上限)?/.test(value)) return "最大弹药量";
    if (/^(?:瞄准倍率|瞄准缩放|缩放)/.test(value)) return "瞄准倍率";
    if (/^滑行暴击(?:几率)?/.test(value)) return "滑行暴击几率";
    if (/^重击效率/.test(value)) return "重击效率";
    if (/^近战触发(?:几率)?/.test(value)) return "近战触发几率";
    if (/^(?:爆头|弱点)暴击(?:几率)?/.test(value)) return "爆头暴击几率";
    if (/^(?:处决|终结)伤害/.test(value)) return "处决伤害";
    if (/^(?:重击|下砸)伤害/.test(value)) return "重击伤害";
    if (/^(?:光束|射线)距离/.test(value)) return "光束距离";
    if (/^自伤减免/.test(value)) return "自伤减免";
    return value;
  }

  function readChatPayload() {
    try {
      const main = window.overwolf && overwolf.windows && typeof overwolf.windows.getMainWindow === "function"
        ? overwolf.windows.getMainWindow() : null;
      const payload = main && main.__ALECAFRAME_ZH_CN_RIVEN_CHAT_RESULT__;
      const activeAt = Number(main && main.__ALECAFRAME_ZH_CN_RIVEN_CHAT_ACTIVE_AT__ || 0);
      if (payload && activeAt && Date.now() - activeAt <= 11000 && payload.parsed && payload.parsed.success) return payload;
      const raw = localStorage.getItem(chatResultKey);
      const localActiveAt = Number(localStorage.getItem(chatActiveKey) || 0);
      if (!raw || !localActiveAt || Date.now() - localActiveAt > 11000) return null;
      const localPayload = JSON.parse(raw);
      return localPayload && localPayload.parsed && localPayload.parsed.success ? localPayload : null;
    } catch (error) { return null; }
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (character) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character];
    });
  }

  function nativeDescription(trait) {
    const sign = trait && trait.sign ? trait.sign : "";
    const value = trait && typeof trait.value === "number" ? trait.value : "?";
    const unit = trait && trait.unit || "";
    const text = trait && trait.text || "未知词条";
    return escapeHtml(sign + value + unit + " " + text);
  }

  // Defense in depth: render only a signed Chinese stat that has a known
  // native riven attribute. This still excludes rank/polarity noise such as
  // `18V`, while allowing valid non-percent stats such as 穿透 (Punch Through).
  function displayableTrait(trait) {
    return trait && typeof trait.text === "string" &&
      /[\u4e00-\u9fff]/.test(trait.text) &&
      typeof trait.value === "number" && Number.isFinite(trait.value) &&
      (trait.sign === "+" || trait.sign === "-") &&
      !!nativeTraitIds[canonicalNativeTraitName(trait.text)];
  }

  // This is a direct port of RivenExplorerHelper.GetRivenGradeFromRAWAttrList
  // from AlecaFrameClientLib.  The native method grades a trait from the
  // per-weapon good-roll list, not from its rolled numeric value.  The history
  // endpoint exposes the same goodRollData under the currently logged-in
  // AlecaFrame session, so no guessed thresholds are involved here.
  function englishAttrToNativeId(history) {
    const result = Object.create(null);
    (history && history.attrs || []).forEach(function (attr) {
      const english = String(attr && attr.name || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().toLowerCase();
      const id = String(attr && attr.internalName || "");
      if (english && id) result[english] = id;
    });
    return result;
  }

  function nativeGradeSets(history) {
    const lookup = englishAttrToNativeId(history);
    const goodRollData = history && history.goodRollData || {};
    const goodRolls = Array.isArray(goodRollData.goodAttrs) ? goodRollData.goodAttrs : [];
    const acceptedBad = new Set((goodRollData.acceptedBadAttrs || []).map(function (attr) {
      return lookup[String(attr && attr.text || "").replace(/\s+/g, " ").trim().toLowerCase()] || "";
    }).filter(Boolean));
    const rolls = goodRolls.map(function (roll) {
      const ids = function (items) {
        return new Set((items || []).map(function (attr) {
          return lookup[String(attr && attr.text || "").replace(/\s+/g, " ").trim().toLowerCase()] || "";
        }).filter(Boolean));
      };
      return { mandatory: ids(roll && roll.mandatory), optional: ids(roll && roll.optional) };
    });
    return { rolls: rolls, acceptedBad: acceptedBad };
  }

  function exactNativeGrades(card, history) {
    const sets = nativeGradeSets(history);
    const positiveIds = [];
    const negativeIds = [];
    (card && card.traits || []).filter(displayableTrait).forEach(function (trait) {
      const id = nativeTraitIds[canonicalNativeTraitName(trait.text)];
      if (!id) return;
      if (trait.sign === "+") positiveIds.push(id);
      else if (trait.sign === "-") negativeIds.push(id);
    });

    const positiveGrades = positiveIds.map(function (id) {
      if (sets.rolls.some(function (roll) { return roll.mandatory.has(id); })) return "Decisive";
      if (sets.rolls.some(function (roll) { return roll.optional.has(id); })) return "Good";
      return "NotHelping";
    });
    const negativeGrades = negativeIds.map(function (id) {
      if (sets.acceptedBad.has(id)) return "Good";
      if (sets.rolls.some(function (roll) { return roll.mandatory.has(id) || roll.optional.has(id); })) return "Bad";
      return "NotHelping";
    });

    // Native enum values: Decisive=0, Good=1, NotHelping=2, Bad=3.
    const decisiveOrGood = positiveGrades.filter(function (grade) { return grade === "Decisive" || grade === "Good"; }).length;
    const hasCompleteGoodRoll = sets.rolls.some(function (roll) {
      const mandatoryOk = Array.from(roll.mandatory).every(function (id) { return positiveIds.indexOf(id) >= 0; });
      const optionalCount = Array.from(roll.optional).filter(function (id) { return positiveIds.indexOf(id) >= 0; }).length;
      // Native IL uses `mandatory.All(...)` (Boolean, therefore 1) plus the
      // number of matching optional traits; its remote roll schema has one
      // mandatory trait per good-roll alternative.
      return mandatoryOk && (1 + optionalCount === positiveIds.length);
    });
    const hasBadNegative = negativeGrades.some(function (grade) { return grade === "Bad"; });
    const hasNotHelpingNegative = negativeGrades.some(function (grade) { return grade === "NotHelping"; });
    const allNegativesAccepted = negativeGrades.every(function (grade) { return grade === "Good"; });
    let grade;
    // The decision tree below mirrors the native IL branches precisely.
    if (hasBadNegative) {
      grade = (hasCompleteGoodRoll && decisiveOrGood >= 2) || decisiveOrGood >= 3 ? "HasPotential" : "Bad";
    } else if (hasNotHelpingNegative) {
      grade = hasCompleteGoodRoll || decisiveOrGood >= 2 ? "Good" : decisiveOrGood >= 1 ? "HasPotential" : "Bad";
    } else {
      grade = decisiveOrGood >= 2
        ? (hasCompleteGoodRoll && allNegativesAccepted ? "Perfect" : "Good")
        : decisiveOrGood >= 1 ? "HasPotential" : "Bad";
    }
    return { grade: grade, positive: positiveGrades, negative: negativeGrades };
  }

  function nativePayloadCard(card, nativeKey, native) {
    const positive = [];
    const negative = [];
    const seen = Object.create(null);
    const exactGrades = exactNativeGrades(card, native && native.history);
    let positiveIndex = 0;
    let negativeIndex = 0;
    (card.traits || []).filter(displayableTrait).forEach(function (trait) {
      // Native Vue renders exactly what is supplied. De-duplicate here as a
      // final boundary in case an older bridge instance briefly publishes the
      // same trait more than once while its stable cache is warming up.
      const normalizedTrait = Object.assign({}, trait, { text: canonicalDisplayTraitName(trait.text) });
      // A stable OCR cache may contain both a clipped observation (暴击) and
      // its complete observation (暴击几率).  The canonical text is the
      // de-duplication identity; same stat/value/sign must render once.
      const key = [normalizedTrait.sign, normalizedTrait.value, normalizedTrait.unit, normalizedTrait.text].join("|");
      if (seen[key]) return;
      seen[key] = true;
      const isNegative = normalizedTrait.sign === "-";
      const target = isNegative ? negative : positive;
      target.push({
        description: nativeDescription(normalizedTrait),
        grade: nativeRangeLabel(normalizedTrait, native && native.attrs),
        rollGrade: isNegative ? (exactGrades.negative[negativeIndex++] || "NotHelping") : (exactGrades.positive[positiveIndex++] || "NotHelping"),
        rawRandomValue: nativeRangeProgress(normalizedTrait, native && native.attrs),
        traitNameEnglish: rivenTraitNames[normalizedTrait.text] || normalizedTrait.text || "Unknown"
      });
    });
    const rank = Number.isFinite(card.rank) ? Math.max(0, Math.min(10, card.rank)) : 8;
    return {
      weaponName: card.weaponNameChinese || "未识别武器",
      name: card.rivenSurname || (card.rivenName || "").replace(card.weaponNameChinese || "", "") || "未识别裂罅",
      grade: exactGrades.grade,
      __zhNativeKey: nativeKey || cardVisualIdentity(card),
      statsPerWeapon: [{ byLevel: Array.from({ length: 11 }, function () {
        return { positiveTraits: positive, negativeTraits: negative };
      }) }],
      currentImprovementLevel: rank,
      similarRivens: native && Array.isArray(native.similarRivens) ? native.similarRivens : [],
      goodRollData: native && native.goodRollData ? native.goodRollData : { goodAttrs: [], acceptedBadAttrs: [] }
    };
  }

  function nativeRangeAttr(trait, attrs) {
    const id = nativeTraitIds[canonicalNativeTraitName(trait && trait.text)];
    return id && Array.isArray(attrs) ? attrs.find(function (attr) { return attr && attr.internalName === id; }) : null;
  }

  function nativeRangeLabel(trait, attrs) {
    const attr = nativeRangeAttr(trait, attrs);
    if (!attr || !Number.isFinite(attr.min) || !Number.isFinite(attr.max)) return "";
    const unit = attr.isPercentage ? "%" : (trait && trait.unit === "x" ? "x" : "");
    return "区间 " + attr.min + "–" + attr.max + unit;
  }

  function nativeRangeProgress(trait, attrs) {
    const attr = nativeRangeAttr(trait, attrs);
    if (!attr || !Number.isFinite(trait && trait.value) || !Number.isFinite(attr.min) || !Number.isFinite(attr.max)) return 0;
    const low = Math.min(Math.abs(attr.min), Math.abs(attr.max));
    const high = Math.max(Math.abs(attr.min), Math.abs(attr.max));
    if (high <= low) return 0;
    return Math.max(0, Math.min(1, (Math.abs(trait.value) - low) / (high - low)));
  }

  function makeNativeOverlayData(payload) {
    const parsed = payload.parsed || {};
    const observed = Array.isArray(parsed.cards) ? parsed.cards : [];
    // cardIndex is screen order from OCR title geometry, not a selected-card
    // index. Keep native rivenLeft/rivenRight pinned to the same game sides.
    const cards = observed.slice().sort(function (left, right) {
      return Number(left.cardIndex) - Number(right.cardIndex);
    });
    const left = cards[0] || null;
    const right = cards[1] || null;
    const sameIdentity = left && right && String(left.rivenSurname || left.rivenName || "").toLowerCase() ===
      String(right.rivenSurname || right.rivenName || "").toLowerCase();
    const isChatLink = payload && payload.kind === "chat-link";
    const completePair = !!left && !!right && !sameIdentity;
    return {
      enabled: true,
      rivenLeft: { show: isChatLink || completePair, loading: false, errorHappened: false, data: nativePayloadCard(left || {}, left && cardVisualIdentity(left), left && cachedNativeForCard(left)) },
      rivenRight: { show: completePair, loading: false, errorHappened: false, data: nativePayloadCard(right || {}, right && cardVisualIdentity(right), right && cachedNativeForCard(right)) }
    };
  }

  function renderNativeApp(payload) {
    const app = window.rivenOverlayApp;
    if (!app || !payload) return false;
    installSimilarRivenFourStatStyle();
    const data = makeNativeOverlayData(payload);
    app.data = data;
    app.selectedModLevel = Math.max(
      data.rivenLeft.data.currentImprovementLevel || 0,
      data.rivenRight.data.currentImprovementLevel || 0
    );
    app.selectedWeaponIndex = 0;
    app.leftShown = !!data.rivenLeft.show;
    app.rightShown = !!data.rivenRight.show;
    refreshNativeCardData(payload);
    return true;
  }

  function hideNativeApp() {
    const app = window.rivenOverlayApp;
    if (!app || !app.data) return;
    if (app.data.rivenLeft) app.data.rivenLeft.show = false;
    if (app.data.rivenRight) app.data.rivenRight.show = false;
  }

  function activateNativeOverlay() {
    const app = window.rivenOverlayApp;
    if (!app) return;
    const nativeRefresh = typeof app.refresh === "function" ? app.refresh : null;
    if (!app.__alecaframeZhCnNativeRefresh) {
      app.__alecaframeZhCnNativeRefresh = nativeRefresh;
      app.refresh = function () {
        const payload = readPayload() || readChatPayload();
        if (payload) return renderNativeApp(payload);
        // Never permit a late original OCR call to replace the fresh Chinese
        // result with partial or duplicated raw traits.
        if (lastPayloadAt && Date.now() - lastPayloadAt <= maxAgeMs) return;
        const nativePlugin = window.plugin && typeof window.plugin.get === "function" ? window.plugin.get() : null;
        // Keep the native callback installed for chat links; a linked riven is
        // opened by the plugin's onRivenOverlayChange event rather than by the
        // Chinese comparison publisher.  The probe below only records that
        // result and leaves original native drawing untouched.
        collectChatNativeDiagnostic(nativePlugin, "native-refresh");
        if (typeof app.__alecaframeZhCnNativeRefresh === "function") {
          const response = app.__alecaframeZhCnNativeRefresh.apply(app, arguments);
          // GetRivenOverlayData in the native refresh is asynchronous.  Probe
          // once after it has populated Vue's data so the first chat-link
          // notification is also recorded.
          setTimeout(function () { collectChatNativeDiagnostic(nativePlugin, "native-refresh-settled"); }, 350);
          return response;
        }
      };
    }
  }
  const nativeCloseNow = typeof window.closeNow === "function" ? window.closeNow : null;
  window.closeNow = function () {
    const payload = readPayload() || readChatPayload();
    if (payload) {
      renderNativeApp(payload);
      return;
    }
    if (nativeCloseNow) nativeCloseNow();
  };

  let lastPayloadAt = 0;
  let lastRenderedPayloadAt = 0;
  function refreshNativeLayout() {
    activateNativeOverlay();
    installChatNativeEventDiagnostic();
    const payload = readPayload() || readChatPayload();
    if (payload) {
      lastPayloadAt = payload.updatedAt || Date.now();
      // The bridge is polled more often than OCR publishes. Re-applying an
      // identical payload continuously races Vue's un-keyed trait rows and is
      // the source of the intermittent duplicate on the right card.
      if (lastPayloadAt !== lastRenderedPayloadAt) {
        lastRenderedPayloadAt = lastPayloadAt;
        renderNativeApp(payload);
      }
      return true;
    }
    if (lastPayloadAt && Date.now() - lastPayloadAt > maxAgeMs) {
      hideNativeApp();
      lastPayloadAt = 0;
      lastRenderedPayloadAt = 0;
    }
    return false;
  }

  refreshNativeLayout();
  setInterval(refreshNativeLayout, 350);
})();

