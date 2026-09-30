(() => {
  "use strict";

  function getPrice(listings, reducer) {
    if (!Array.isArray(listings)) return undefined;
    const prices = listings
      .map(listing => Number(listing?.platimun))
      .filter(price => Number.isFinite(price) && price > 0);
    return prices.length ? reducer(...prices) : undefined;
  }

  function findInventoryItem(itemName) {
    const inventoryApp = window.inventoryApp;
    const items = inventoryApp?.items;
    if (!Array.isArray(items)) return undefined;

    const normalizedName = String(itemName ?? "").trim().toLocaleLowerCase();
    const directMatch = items.find(item => String(item?.name ?? "").trim().toLocaleLowerCase() === normalizedName);
    if (directMatch) return directMatch;

    // Item labels are visually translated with a CSS pseudo-element. Locate
    // the clicked display label and use its matching card position as fallback.
    const cards = [...document.querySelectorAll("#inventoryObjectContainer > .inventoryObject")];
    const cardIndex = cards.findIndex(card => {
      const label = card.querySelector(".inventoryItemName > .normalItem");
      return [label?.textContent, label?.dataset?.zhLabel]
        .some(value => String(value ?? "").trim().toLocaleLowerCase() === normalizedName);
    });
    return cardIndex >= 0 ? items[cardIndex] : undefined;
  }

  function syncInventoryItemPrice(itemName, dataToShowJSON) {
    const item = findInventoryItem(itemName);
    if (!item) {
      console.warn("[AlecaFrame 中文补丁] 未找到待同步的仓库物品：", itemName);
      return;
    }

    let data;
    try {
      data = JSON.parse(dataToShowJSON);
    } catch {
      return;
    }

    const lowestSellPrice = getPrice(data?.sellListings, Math.min);
    const highestBuyPrice = getPrice(data?.buyListings, Math.max);
    if (lowestSellPrice !== undefined) item.sellPrice = lowestSellPrice;
    if (highestBuyPrice !== undefined) item.buyPrice = highestBuyPrice;
  }

  function enableInventoryPriceSync() {
    const marketPlugin = window.plugin?.get?.();
    if (!marketPlugin?.GetBuySellWindowData || marketPlugin.__zhInventoryPriceSyncEnabled) {
      return false;
    }

    const originalGetBuySellWindowData = marketPlugin.GetBuySellWindowData.bind(marketPlugin);
    marketPlugin.GetBuySellWindowData = function (itemName, callback) {
      return originalGetBuySellWindowData(itemName, (success, ...response) => {
        try {
          callback(success, ...response);
        } finally {
          // A failed lookup must preserve the currently displayed cache value.
          if (success) syncInventoryItemPrice(itemName, response[0]);
        }
      });
    };
    marketPlugin.__zhInventoryPriceSyncEnabled = true;
    console.info("[AlecaFrame 中文补丁] 仓库价格同步已加载");
    return true;
  }

  function waitForInventoryPriceSync(attempt = 0) {
    if (enableInventoryPriceSync() || attempt >= 40) return;
    setTimeout(() => waitForInventoryPriceSync(attempt + 1), 250);
  }

  waitForInventoryPriceSync();
})();
