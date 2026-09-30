(function () {
  "use strict";

  if (window.__ALECAFRAME_ZH_CN_RIVEN_OCR__) return;
  window.__ALECAFRAME_ZH_CN_RIVEN_OCR__ = true;

  const processEndpoint = "http://127.0.0.1:38147/process-riven";
  const auditEndpoint = "http://127.0.0.1:38147/audit";
  const resultKey = "__alecaframeZhCnRivenOverlayResult";
  const activeKey = "__alecaframeZhCnRivenOverlayActive";
  const chatResultKey = "__alecaframeZhCnRivenChatOverlayResult";
  const chatActiveKey = "__alecaframeZhCnRivenChatOverlayActive";
  const idleProbeIntervalMs = 12000;
  const activeProbeIntervalMs = 1600;
  // Chat-linked rivens are static, high-contrast single cards.  Opening them
  // does not need the two-frame safeguard used for dim reroll comparison
  // cards, so the first complete result can be shown immediately.
  const chatConfirmationFrames = 1;
  // A Chinese card may be visible before Paddle sees every thin +/- glyph on
  // the dim side.  During that very short warm-up only, sample quickly so we
  // publish one complete pair instead of opening the native overlay with a
  // missing negative line.
  const warmupProbeIntervalMs = 700;
  const inactiveClearMs = 3200;
  // Only immediately after Warframe regains focus, retry a blank early frame at
  // the existing 700 ms warm-up cadence. This avoids the prior 12 s idle gap
  // while keeping the normal idle capture cost unchanged.
  const focusProbeWindowMs = 3000;
  let installed = false;
  let captureInProgress = false;
  let lastCaptureAt = 0;
  let lastMatchAt = 0;
  let lastCandidateAt = 0;
  let lastFingerprint = "";
  // Before opening a fresh comparison, require the exact complete pair twice.
  // This suppresses a single transient OCR frame while retaining the existing
  // 700 ms warm-up cadence; already-open overlays still refresh immediately.
  let pendingFingerprint = "";
  let pendingFingerprintCount = 0;
  let lastOpenAttemptAt = 0;
  let wasGameFocused = false;
  let focusProbeUntil = 0;
  // Paddle sees the dim, unselected card less reliably than the selected one.
  // Keep the strongest observation for each of the two on-screen cards while
  // the reroll UI remains open. A later weak frame must never turn +177.8%
  // into 7.8%, or replace a complete surname with a truncated one.
  let stableCards = [];
  // Per identity, retain how many actual Chinese percentage rows were visible
  // before sign filtering.  The dim card may expose its three rows as
  // `177.8%`, `+257.6%`, `50.5%`: filtering first used to forget the two
  // unsigned rows and incorrectly treat the one signed row as complete.
  let expectedTraitCounts = Object.create(null);
  // Last complete two-card screen layout. Identity/traits live in stableCards;
  // positions must come only from a frame where both card columns are visible.
  let stableLayout = [];
  let stableSelectedIdentity = "";
  let pendingChatFingerprint = "";
  let pendingChatFingerprintCount = 0;
  let lastChatFingerprint = "";
  let lastChatMatchAt = 0;
  // Chat cards are static single cards. Keep the strongest signed observation
  // per stat so a later OCR frame that loses a thin +/- glyph cannot remove it.
  let stableChatCard = null;

  window.__ALECAFRAME_ZH_CN_OPEN_RIVEN_OVERLAY__ = function (reason) {
    const now = Date.now();
    if (now - lastOpenAttemptAt < 900) return;
    lastOpenAttemptAt = now;
    try {
      const windowsApi = window.overwolf && window.overwolf.windows;
      if (!windowsApi || typeof windowsApi.obtainDeclaredWindow !== "function" ||
          typeof windowsApi.restore !== "function") {
        audit("RIVEN_OVERLAY_OPEN_UNAVAILABLE", "Overwolf windows API unavailable");
        return;
      }
      audit("RIVEN_OVERLAY_OPEN_REQUESTED", reason || "publish");
      // openWindowAsync/obtainDeclaredWindowAsync are lexical consts in the
      // original helper, not window properties. Call the Overwolf API directly.
      windowsApi.obtainDeclaredWindow("RivenOverlay", function (result) {
        const id = result && result.window && result.window.id;
        audit("RIVEN_OVERLAY_OBTAIN_RESULT", id ? "id=" + id : JSON.stringify(result || {}));
        if (!id) return;
        windowsApi.restore(id, function (restoreResult) {
          audit("RIVEN_OVERLAY_OPEN_RESULT", JSON.stringify(restoreResult || {}));
        });
      });
    } catch (error) {
      audit("RIVEN_OVERLAY_OPEN_FAILED", String(error && error.message || error));
    }
  };

  function audit(event, detail) {
    fetch(auditEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: event, detail: detail || "" })
    }).catch(function () { });
  }

  function traitQuality(trait) {
    if (!trait || !trait.text || !Number.isFinite(Number(trait.value))) return -100;
    let score = 20 + String(trait.text).length * 3;
    if (trait.sign === "+" || trait.sign === "-") score += 80;
    if (trait.signRecognized) score += 40;
    if (trait.unit === "%") score += 15;
    if (Number(trait.value) >= 10) score += 10;
    score += Math.min(15, Math.round(Number(trait.confidence || 0) * 15));
    return score;
  }

  function cardQuality(card) {
    if (!card || !card.detected) return -1000;
    const traits = Array.isArray(card.traits) ? card.traits : [];
    return (card.rivenName ? String(card.rivenName).length * 4 : 0) +
      traits.reduce(function (sum, trait) { return sum + Math.max(0, traitQuality(trait)); }, 0) +
      (Number.isFinite(card.rank) ? 25 : 0);
  }

  function usableTrait(trait) {
    // Filters rank UI, polarity glyphs, card-frame numbers and other OCR noise.
    return trait && typeof trait.text === "string" &&
      /[\u4e00-\u9fff]/.test(trait.text) &&
      Number.isFinite(Number(trait.value)) &&
      trait.unit === "%" &&
      (trait.sign === "+" || trait.sign === "-");
  }

  function canonicalTraitKey(text) {
    const value = String(text || "").replace(/\s+/g, "");
    // The dim card regularly loses the final glyph.  These are not separate
    // stats: e.g. 弹匣、弹匣容、弹匣容量 all mean Magazine Capacity.
    if (/^弹(?:匣(?:容|容量)?|厘|便容量?)/.test(value)) return "弹匣容量";
    if (/^多重(?:射|身|射击)?$/.test(value)) return "多重射击";
    if (/^暴击伤害?$/.test(value)) return "暴击伤害";
    if (/^暴击(?:几|几率)?$/.test(value)) return "暴击几率";
    if (/^伤害$/.test(value)) return "伤害";
    if (/^射速$/.test(value)) return "射速";
    if (/^触发(?:几率)?$/.test(value)) return "触发几率";
    if (/^装填(?:速度)?$/.test(value)) return "装填速度";
    return value;
  }

  function canonicalTrait(trait) {
    if (!trait) return trait;
    const key = canonicalTraitKey(trait.text);
    return Object.assign({}, trait, { text: key });
  }

  // Never let raw OCR output reach the overlay.  In particular, `18V` is the
  // card rank/polarity decoration, not a riven stat.  This must run before a
  // card first enters stableCards as well as during later merges.
  function sanitizeCard(card) {
    if (!card) return null;
    const rawTraits = Array.isArray(card.traits) ? card.traits : [];
    // Count every Chinese percentage row before filtering signs.  A row such
    // as `50.5% 多重射击` is a real observed stat, but it is not safe to show
    // until its +/- glyph has actually been read.
    const observedTraitCount = rawTraits.filter(function (trait) {
      return trait && typeof trait.text === "string" &&
        /[\u4e00-\u9fff]/.test(trait.text) && trait.unit === "%" &&
        Number.isFinite(Number(trait.value));
    }).length;
    const traits = rawTraits
      .filter(usableTrait)
      .map(canonicalTrait);
    return Object.assign({}, card, {
      traits: traits,
      signedTraitCount: traits.length,
      observedTraitCount: observedTraitCount,
      completeSignedTraits: observedTraitCount > 0 && traits.length >= observedTraitCount,
      detected: !!card.detected && traits.length > 0 && !!card.weaponNameEnglishCandidate
    });
  }

  function sameCardIdentity(saved, incoming) {
    const left = String(saved && (saved.rivenSurname || saved.rivenName) || "").toLowerCase();
    const right = String(incoming && (incoming.rivenSurname || incoming.rivenName) || "").toLowerCase();
    if (!left || !right) return false;
    if (left === right) return true;
    // Paddle occasionally clips a surname (Crita-s instead of Crita-satitin).
    // A sufficiently long common prefix is the same card, not a third card.
    const shortName = left.length < right.length ? left : right;
    const longName = left.length < right.length ? right : left;
    return shortName.length >= 5 && longName.indexOf(shortName) === 0;
  }

  function cardIdentity(card) {
    return String(card && (card.rivenSurname || card.rivenName) || "").toLowerCase();
  }

  function mergeCard(previous, incoming) {
    incoming = sanitizeCard(incoming);
    if (!incoming) return previous || null;
    if (!previous) return incoming;
    // Card identity is the Latin riven surname, not cardIndex. The rendered
    // positions swap whenever the player changes side, so merging by index
    // mixes both cards and causes duplicated traits.
    const merged = Object.assign({}, previous, incoming, { cardIndex: incoming.cardIndex });
    const oldTitle = String(previous.rivenName || "");
    const newTitle = String(incoming.rivenName || "");
    // A longer Latin surname is generally a more complete observation. Keep it
    // unless the weapon printed on the card has changed.
    if (previous.weaponNameEnglishCandidate === incoming.weaponNameEnglishCandidate && oldTitle.length > newTitle.length) {
      merged.rivenName = oldTitle;
      merged.rivenSurname = previous.rivenSurname || merged.rivenSurname;
    }
    merged.rank = Number.isFinite(incoming.rank) ? incoming.rank : previous.rank;
    const byText = Object.create(null);
    (previous.traits || []).filter(usableTrait).map(canonicalTrait).forEach(function (trait) { byText[trait.text] = trait; });
    (incoming.traits || []).filter(usableTrait).map(canonicalTrait).forEach(function (trait) {
      const old = byText[trait.text];
      // A signless OCR result is incomplete. It is never allowed to replace a
      // signed result already seen for this exact Chinese stat.
      if (!old || traitQuality(trait) > traitQuality(old)) byText[trait.text] = trait;
    });
    merged.traits = Object.keys(byText).map(function (key) { return byText[key]; });
    merged.signedTraitCount = merged.traits.filter(function (trait) {
      return trait.sign === "+" || trait.sign === "-";
    }).length;
    merged.detected = merged.traits.length > 0 && !!merged.weaponNameEnglishCandidate;
    merged.observedTraitCount = Math.max(Number(previous.observedTraitCount || 0), Number(incoming.observedTraitCount || 0));
    merged.completeSignedTraits = merged.observedTraitCount > 0 && merged.traits.length >= merged.observedTraitCount;
    return merged;
  }

  function isRenderablePair(parsed) {
    const cards = parsed && Array.isArray(parsed.cards) ? parsed.cards : [];
    return cards.length === 2 && cards.every(function (card) {
      const expected = Number(expectedTraitCounts[cardIdentity(card)] || card.observedTraitCount || 0);
      return card && card.detected && card.completeSignedTraits &&
        expected > 0 && (card.traits || []).length >= expected;
    });
  }

  function clearPublishedPayload() {
    try {
      window.__ALECAFRAME_ZH_CN_RIVEN_RESULT__ = null;
      window.__ALECAFRAME_ZH_CN_RIVEN_ACTIVE_AT__ = 0;
      localStorage.removeItem(activeKey);
      localStorage.removeItem(resultKey);
    } catch (error) { }
  }

  function chatTraitUsable(trait) {
    // Some legitimate rivens (for example Punch Through) have no percentage
    // unit. Require a signed Chinese stat, not a particular display unit.
    return trait && typeof trait.text === "string" && /[\u4e00-\u9fff]/.test(trait.text) &&
      Number.isFinite(Number(trait.value)) && (trait.sign === "+" || trait.sign === "-");
  }

  function mergeChatCard(previous, incoming) {
    const incomingTraits = (incoming && incoming.traits || []).filter(chatTraitUsable).map(canonicalTrait);
    if (!previous) return Object.assign({}, incoming, { traits: incomingTraits });
    const sameWeapon = previous.weaponNameEnglishCandidate === incoming.weaponNameEnglishCandidate;
    const sameSurname = sameCardIdentity(previous, incoming);
    if (!sameWeapon || !sameSurname) return Object.assign({}, incoming, { traits: incomingTraits });
    const merged = Object.assign({}, previous, incoming);
    const byText = Object.create(null);
    (previous.traits || []).filter(chatTraitUsable).map(canonicalTrait).forEach(function (trait) { byText[trait.text] = trait; });
    incomingTraits.forEach(function (trait) {
      const old = byText[trait.text];
      if (!old || traitQuality(trait) > traitQuality(old)) byText[trait.text] = trait;
    });
    merged.traits = Object.keys(byText).map(function (key) { return byText[key]; });
    if (String(previous.rivenName || "").length > String(incoming.rivenName || "").length) {
      merged.rivenName = previous.rivenName;
      merged.rivenSurname = previous.rivenSurname || merged.rivenSurname;
    }
    return merged;
  }

  // Chat links provide exactly one static card. This is deliberately separate
  // from the reroll pair cache, so it can never contaminate left/right cards.
  function publishChatLinkedRiven(result) {
    const parsed = result && result.parsed;
    const sourceCards = parsed && Array.isArray(parsed.cards) ? parsed.cards : [];
    if (sourceCards.length !== 1) return false;
    const observedCard = sourceCards[0];
    if (!observedCard || !observedCard.detected || !observedCard.weaponNameEnglishCandidate) return false;
    if (observedCard.chatLinkEvidence !== true) {
      audit("RIVEN_CHAT_SCENE_REJECTED", "missing-strict-chat-evidence " + String(observedCard.rivenName || observedCard.weaponNameEnglishCandidate));
      return false;
    }
    stableChatCard = mergeChatCard(stableChatCard, observedCard);
    const card = stableChatCard;
    if (!card || card.traits.length < 2) return false;
    const chatParsed = Object.assign({}, parsed, {
      cards: [card], traits: card.traits, rivenName: card.rivenName,
      weaponNameChinese: card.weaponNameChinese, weaponNameEnglishCandidate: card.weaponNameEnglishCandidate,
      rivenSurname: card.rivenSurname, rank: card.rank
    });
    const next = fingerprint(chatParsed);
    if (next !== pendingChatFingerprint && next !== lastChatFingerprint) {
      pendingChatFingerprint = next;
      pendingChatFingerprintCount = 1;
      // The chat-link card is not a dim comparison card. Publishing this
      // complete single-card frame eliminates one screenshot/OCR round trip
      // without increasing the capture cadence or background CPU/GPU use.
      if (chatConfirmationFrames > 1) {
        audit("RIVEN_CHAT_RESULT_CONFIRMING", "1/" + chatConfirmationFrames + " " + card.weaponNameEnglishCandidate);
        return true;
      }
    }
    if (next === pendingChatFingerprint && next !== lastChatFingerprint && ++pendingChatFingerprintCount < chatConfirmationFrames) return true;
    const now = Date.now();
    const payload = { updatedAt: now, kind: "chat-link", parsed: chatParsed, screenKind: result.screenKind || "riven-diagnostic" };
    try {
      window.__ALECAFRAME_ZH_CN_RIVEN_CHAT_RESULT__ = payload;
      window.__ALECAFRAME_ZH_CN_RIVEN_CHAT_ACTIVE_AT__ = now;
      localStorage.setItem(chatResultKey, JSON.stringify(payload));
      localStorage.setItem(chatActiveKey, String(now));
    } catch (error) { audit("RIVEN_CHAT_RESULT_CACHE_FAILED", String(error && error.message || error)); return false; }
    const changed = next !== lastChatFingerprint;
    lastChatFingerprint = next;
    pendingChatFingerprint = "";
    pendingChatFingerprintCount = 0;
    lastChatMatchAt = now;
    audit(changed ? "RIVEN_CHAT_RESULT_PUBLISHED" : "RIVEN_CHAT_RESULT_REFRESHED", "card=" + card.weaponNameEnglishCandidate + " traits=" + card.traits.length);
    if (changed && typeof window.__ALECAFRAME_ZH_CN_OPEN_RIVEN_OVERLAY__ === "function") window.__ALECAFRAME_ZH_CN_OPEN_RIVEN_OVERLAY__("chat-link");
    return true;
  }

  function stabilize(parsed) {
    if (!parsed || !Array.isArray(parsed.cards)) return parsed;
    // A weak screenshot frequently contains only the highlighted card. It may
    // update that card's stats, but it must never redefine the two card slots.
    const inspected = parsed.cards.map(sanitizeCard).filter(Boolean);
    // Update required stat-row counts before dropping cards with missing signs.
    // This is deliberately separate from `incoming`: a card with zero signed
    // rows is not displayable yet, but it still tells us that three rows must
    // be present before the pair is ever published.
    inspected.forEach(function (card) {
      const key = cardIdentity(card);
      if (key && card.weaponNameEnglishCandidate && Number(card.observedTraitCount || 0) > 0) {
        expectedTraitCounts[key] = Math.max(Number(expectedTraitCounts[key] || 0), Number(card.observedTraitCount || 0));
      }
    });
    const incoming = inspected.filter(function (card) { return card && card.detected; });
    if (!incoming.length) return parsed;
    // A one-card diagnostic snapshot is useful only after the actual two-card
    // comparison has established its layout. Once a card is selected, the
    // native UI exposes the arsenal details panel beside it; its percentage
    // rows are not riven traits. Merging that snapshot would permanently add
    // those panel rows to the selected card's stable cache.
    const hasKnownPair = stableLayout.length === 2 && stableCards.length >= 2;
    if (hasKnownPair && incoming.length < 2 && (!parsed.comparison || parsed.comparison.phase !== "reroll-comparison")) {
      audit("RIVEN_SINGLE_CARD_SKIPPED", "phase=" + String(parsed.phase || "unknown") + " identity=" + cardIdentity(incoming[0]));
      return Object.assign({}, parsed, { cards: stableLayout.slice() });
    }
    const currentWeapon = incoming[0].weaponNameEnglishCandidate;
    if (stableCards.length && stableCards.some(function (card) {
      return card.weaponNameEnglishCandidate !== currentWeapon;
    })) {
      stableCards = [];
      stableLayout = [];
      expectedTraitCounts = Object.create(null);
    }

    incoming.forEach(function (card) {
      const index = stableCards.findIndex(function (saved) { return sameCardIdentity(saved, card); });
      const merged = mergeCard(index >= 0 ? stableCards[index] : null, card);
      if (index >= 0) stableCards[index] = merged;
      else stableCards.push(merged);
    });
    stableCards = stableCards.filter(function (card) { return card && card.detected; });

    // Only a complete frame may establish screen-side positions. cardIndex is
    // generated from title X coordinates by the OCR service: 0 = game left,
    // 1 = game right. Do not use "selected" here: parser selection is a
    // confidence heuristic and not a layout signal.
    const distinctIncoming = incoming.filter(function (card, index, list) {
      return list.findIndex(function (candidate) { return sameCardIdentity(candidate, card); }) === index;
    });
    if (distinctIncoming.length >= 2) {
      stableLayout = distinctIncoming
        .slice()
        .sort(function (left, right) {
          return Number(left.titleCenter || left.cardIndex) - Number(right.titleCenter || right.cardIndex);
        })
        .slice(0, 2)
        .map(function (observed, screenIndex) {
          const saved = stableCards.find(function (card) { return sameCardIdentity(card, observed); });
          return saved ? Object.assign({}, saved, {
            cardIndex: screenIndex,
            titleCenter: observed.titleCenter,
            screenSide: screenIndex === 0 ? "left" : "right"
          }) : null;
        })
        .filter(Boolean);
    } else if (stableLayout.length === 2) {
      // A later dim frame may see only one side. Refresh its cached traits in
      // place without touching either card's screen slot or the other card.
      incoming.forEach(function (observed) {
        const screenIndex = stableLayout.findIndex(function (shown) {
          return sameCardIdentity(shown, observed);
        });
        const saved = stableCards.find(function (card) {
          return sameCardIdentity(card, observed);
        });
        if (screenIndex >= 0 && saved) {
          stableLayout[screenIndex] = Object.assign({}, saved, {
            cardIndex: screenIndex,
            titleCenter: stableLayout[screenIndex].titleCenter,
            screenSide: screenIndex === 0 ? "left" : "right"
          });
        }
      });
    }

    const cards = (stableLayout.length === 2 ? stableLayout : [])
      .map(function (card) {
        const expected = Number(expectedTraitCounts[cardIdentity(card)] || card.observedTraitCount || 0);
        return Object.assign({}, card, {
          traits: (card.traits || []).slice(),
          observedTraitCount: expected,
          completeSignedTraits: expected > 0 && (card.traits || []).length >= expected
        });
      });
    // Never display one card in both native slots. Wait for a complete layout.
    if (cards.length < 2) return Object.assign({}, parsed, { cards: [] });

    // The parser's selectedCardIndex is positional, so it cannot be reused
    // after stable cards have been re-ordered. Convert the observed selection
    // to an identity, then locate that identity in the preserved layout.
    const observedSelectedIndex = parsed.comparison && parsed.comparison.selectedCardIndex;
    const observedSelected = incoming.find(function (card) {
      return card.cardIndex === observedSelectedIndex;
    });
    if (observedSelected) {
      stableSelectedIdentity = String(observedSelected.rivenSurname || observedSelected.rivenName || "").toLowerCase();
    }
    const selected = cards.find(function (card) {
      return stableSelectedIdentity && sameCardIdentity(card, { rivenSurname: stableSelectedIdentity });
    }) || cards[0];
    const output = Object.assign({}, parsed, {
      cards: cards,
      rivenName: selected.rivenName,
      weaponNameChinese: selected.weaponNameChinese,
      weaponNameEnglishCandidate: selected.weaponNameEnglishCandidate,
      rivenSurname: selected.rivenSurname,
      rank: Number.isFinite(selected.rank) ? selected.rank : parsed.rank,
      traits: selected.traits,
      comparison: Object.assign({}, parsed.comparison || {}, { selectedCardIndex: selected.cardIndex })
    });
    return output;
  }

  function fingerprint(parsed) {
    if (!parsed || !Array.isArray(parsed.cards)) return "";
    return parsed.cards.map(function (card) {
      return [card.rivenName || "", (card.traits || []).map(function (trait) {
        return [trait.sign || "", trait.value || "", trait.text || ""].join("");
      }).join("|")].join(":");
    }).join("||");
  }

  function publish(result) {
    if (!result || !result.success || !result.parsed || !result.parsed.success) return false;
    // A detected single chat card must immediately switch the next probe to
    // warm-up cadence, otherwise the second confirmation could wait 12 s.
    lastCandidateAt = Date.now();
    if (publishChatLinkedRiven(result)) return true;
    const parsed = stabilize(result.parsed);
    const now = Date.now();
    lastCandidateAt = now;
    if (!isRenderablePair(parsed)) {
      // Keep collecting the same UI at warm-up cadence, but never reveal a
      // partial card.  This is the exact path that previously displayed the
      // left card without `-50.5% 多重射击`.
      clearPublishedPayload();
      audit("RIVEN_RESULT_WARMING", "cards=" + (parsed.cards || []).length + " traits=" + (parsed.cards || []).map(function (card) {
        return (card.signedTraitCount || 0) + "/" + (card.observedTraitCount || 0);
      }).join(","));
      return true;
    }
    const nextFingerprint = fingerprint(parsed);
    // First publication is deliberately confirmed by the next native OCR
    // frame. During a left/right click the dim card can briefly lose a sign
    // or leading digit; opening on that one frame creates a visible wrong
    // overlay that is only corrected 1-2 seconds later.
    if (!lastFingerprint) {
      if (pendingFingerprint !== nextFingerprint) {
        pendingFingerprint = nextFingerprint;
        pendingFingerprintCount = 1;
        audit("RIVEN_RESULT_CONFIRMING", "1/2");
        return true;
      }
      pendingFingerprintCount += 1;
      if (pendingFingerprintCount < 2) {
        audit("RIVEN_RESULT_CONFIRMING", String(pendingFingerprintCount) + "/2");
        return true;
      }
      pendingFingerprint = "";
      pendingFingerprintCount = 0;
    }
    const payload = {
      updatedAt: now,
      parsed: parsed,
      screenKind: result.screenKind || "riven-diagnostic"
    };
    try {
      // localStorage is per Overwolf page. Keep it only as a same-page
      // fallback; the declared RivenOverlay reads this main-window global.
      window.__ALECAFRAME_ZH_CN_RIVEN_RESULT__ = payload;
      window.__ALECAFRAME_ZH_CN_RIVEN_ACTIVE_AT__ = now;
      localStorage.setItem(resultKey, JSON.stringify(payload));
      localStorage.setItem(activeKey, String(now));
    } catch (error) {
      audit("RIVEN_RESULT_CACHE_FAILED", String(error && error.message || error));
      return false;
    }
    lastMatchAt = now;
    const changed = nextFingerprint !== lastFingerprint;
    lastFingerprint = nextFingerprint;
    pendingFingerprint = "";
    pendingFingerprintCount = 0;
    audit(changed ? "RIVEN_RESULT_PUBLISHED" : "RIVEN_RESULT_REFRESHED", "cards=" + parsed.cards.length + " phase=" + parsed.phase);
    try {
      if (changed && typeof window.__ALECAFRAME_ZH_CN_OPEN_RIVEN_OVERLAY__ === "function") {
        window.__ALECAFRAME_ZH_CN_OPEN_RIVEN_OVERLAY__(changed ? "changed" : "refresh");
      }
    } catch (error) {
      audit("RIVEN_OVERLAY_OPEN_FAILED", String(error && error.message || error));
    }
    return true;
  }

  function clearIfInactive(now) {
    const lastActivityAt = Math.max(lastMatchAt || 0, lastChatMatchAt || 0, lastCandidateAt || 0);
    if (!lastActivityAt || now - lastActivityAt < inactiveClearMs) return;
    lastMatchAt = 0;
    lastCandidateAt = 0;
    lastFingerprint = "";
    pendingFingerprint = "";
    pendingFingerprintCount = 0;
    stableCards = [];
    stableLayout = [];
    stableSelectedIdentity = "";
    expectedTraitCounts = Object.create(null);
    pendingChatFingerprint = "";
    pendingChatFingerprintCount = 0;
    lastChatFingerprint = "";
    lastChatMatchAt = 0;
    stableChatCard = null;
    focusProbeUntil = 0;
    try {
      clearPublishedPayload();
      window.__ALECAFRAME_ZH_CN_RIVEN_CHAT_RESULT__ = null;
      window.__ALECAFRAME_ZH_CN_RIVEN_CHAT_ACTIVE_AT__ = 0;
      localStorage.removeItem(chatResultKey);
      localStorage.removeItem(chatActiveKey);
    } catch (error) { }
    audit("RIVEN_CONTEXT_CLEARED", "inactive");
  }

  function install() {
    if (installed) return true;
    const media = window.overwolf && window.overwolf.media;
    const games = window.overwolf && window.overwolf.games;
    if (!media || typeof media.takeScreenshot !== "function" || !games ||
        typeof games.getRunningGameInfo !== "function") return false;

    function probe() {
      const now = Date.now();
      if (captureInProgress) return;
      games.getRunningGameInfo(function (info) {
        if (!info || !info.success || !info.isRunning || !info.gameIsInFocus) {
          wasGameFocused = false;
          clearIfInactive(Date.now());
          return;
        }
        // Returning from another foreground window used to retain the 12 s
        // idle interval.  Capture once immediately after Warframe regains
        // focus, then return to the existing 1.6 s active cadence.  This is a
        // single native screenshot on focus return, not a higher background
        // polling rate.
        const resumedFromOtherWindow = !wasGameFocused;
        wasGameFocused = true;
        if (resumedFromOtherWindow) focusProbeUntil = now + focusProbeWindowMs;
        const hasWarmCandidate = lastCandidateAt && now - lastCandidateAt < inactiveClearMs;
        const hasPublishedMatch = lastMatchAt && now - lastMatchAt < inactiveClearMs;
        const inFocusProbeWindow = now < focusProbeUntil;
        const interval = hasPublishedMatch ? activeProbeIntervalMs : (hasWarmCandidate || inFocusProbeWindow) ? warmupProbeIntervalMs : idleProbeIntervalMs;
        if (!resumedFromOtherWindow && now - lastCaptureAt < interval) return;
        if (resumedFromOtherWindow) {
          lastCaptureAt = 0;
          audit("RIVEN_FOCUS_RESUMED", "immediate-native-probe; warm-window-ms=" + focusProbeWindowMs);
        }
        captureInProgress = true;
        lastCaptureAt = Date.now();
        media.takeScreenshot(function (fileData) {
          if (!fileData || !fileData.success || !fileData.path) {
            captureInProgress = false;
            audit("RIVEN_NATIVE_CAPTURE_FAILED", "no screenshot path");
            return;
          }
          fetch(processEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: fileData.path })
          })
            .then(function (response) { return response.ok ? response.json() : null; })
            .then(function (result) {
              if (!publish(result)) clearIfInactive(Date.now());
            })
            .catch(function (error) {
              audit("RIVEN_NATIVE_CAPTURE_OCR_FAILED", String(error && error.message || error));
              clearIfInactive(Date.now());
            })
            .finally(function () { captureInProgress = false; });
        });
      });
    }

    // This is a low-frequency, independent probe. It does not intercept the
    // native relic screenshot path and does not reuse relic/reward state.
    setInterval(probe, 450);
    installed = true;
    audit("RIVEN_BRIDGE_INSTALLED", "idleProbeMs=" + idleProbeIntervalMs + " warmupProbeMs=" + warmupProbeIntervalMs + " activeProbeMs=" + activeProbeIntervalMs);
    return true;
  }

  const installTimer = setInterval(function () {
    if (install()) clearInterval(installTimer);
  }, 250);
  install();
})();


