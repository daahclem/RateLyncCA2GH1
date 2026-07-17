require("dotenv").config();
const fs = require("fs");
const { chromium } = require("playwright");

const INGEST_URL = process.env.INGEST_URL;
const INGEST_TOKEN = process.env.INGEST_TOKEN;
const HEADLESS = true; // set true in GitHub Actions later

function getOriginConfig(origin) {
  const map = {
    CA: {
      currency: "CAD",
      countryName: "Canada",
      countrySearch: "canada",
      countryCode2: "CA",
      countryCode3: "CAN",
      sendingParam: "CA",
      localePath: "en-ca",
    },
    US: {
      currency: "USD",
      countryName: "United States",
      countrySearch: "united states",
      countryCode2: "US",
      countryCode3: "USA",
      sendingParam: "US",
      localePath: "en-us",
    },
    GB: {
      currency: "GBP",
      countryName: "United Kingdom",
      countrySearch: "united kingdom",
      countryCode2: "GB",
      countryCode3: "GBR",
      sendingParam: "GB",
      localePath: "en-gb",
    },
  };

  return map[origin] || map.CA;
}

function currencyForDestination(destination) {
  if (destination === "GH") return "GHS";
  if (destination === "NG") return "NGN";
  return "GHS";
}

async function postQuote(payload) {
  if (
    !INGEST_URL ||
    !INGEST_TOKEN ||
    INGEST_URL.includes("your-quoteops-app-url") ||
    INGEST_TOKEN.includes("your_secret_token_here")
  ) {
    console.log("INGEST_URL or INGEST_TOKEN not set. Quote extracted locally only:");
    console.log(payload);
    return;
  }

  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ingest failed: ${res.status} ${text}`);
  }
}

function saveDebugText(provider, text) {
  const safe = provider.replace(/\s+/g, "-").toLowerCase();
  fs.writeFileSync(`debug-${safe}.txt`, text || "", "utf8");
}

async function saveScreenshot(page, provider) {
  const safe = provider.replace(/\s+/g, "-").toLowerCase();
  const file = `debug-${safe}.png`;
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

function parseLocaleNumber(value) {
  if (value === null || value === undefined) return null;

  let str = String(value).trim();
  if (!str) return null;

  str = str.replace(/[^\d,.-]/g, "");

  const hasComma = str.includes(",");
  const hasDot = str.includes(".");

  if (hasComma && hasDot) {
    const lastComma = str.lastIndexOf(",");
    const lastDot = str.lastIndexOf(".");

    if (lastComma > lastDot) {
      str = str.replace(/\./g, "").replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  } else if (hasComma) {
    if (/,\d{1,2}$/.test(str)) {
      str = str.replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  } else if (hasDot) {
    const parts = str.split(".");
    if (parts.length > 2) {
      const decimal = parts.pop();
      str = parts.join("") + "." + decimal;
    }
  }

  const num = Number(str);
  return Number.isFinite(num) ? num : null;
}

function extractRateFromText(text, fromCurrency, toCurrency) {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`1\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`${fromCurrency}\\s*1\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`Exchange Rate\\s*1\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`Today[’']s rate:\\s*1(?:\\.00)?\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`rate:?\\s*1\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`([0-9]+(?:\\.[0-9]+)?)\\s*${toCurrency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0 && value < 10000) {
        return value;
      }
    }
  }

  return null;
}

function extractFeeFromText(text, sourceCurrency = "CAD") {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`Transfer fees?:\\s*([0-9.]+)\\s*${sourceCurrency}`, "i"),
    new RegExp(`Fees?:\\s*([0-9.]+)\\s*${sourceCurrency}`, "i"),
    new RegExp(`Zero`, "i"),
    new RegExp(`No transfer fees`, "i"),
    new RegExp(`Fee:?\\s*([0-9.]+)`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (!match) continue;
    if (/Zero/i.test(match[0]) || /No transfer fees/i.test(match[0])) return 0;
    if (match[1]) return Number(match[1]);
  }

  return 0;
}

function extractAmountReceivedFromText(text, currency) {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`Recipient gets\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`They get\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`You receive\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`You get\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`Receive amount\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`([0-9.]+)\\s*${currency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (match && match[1]) return Number(match[1]);
  }

  return null;
}

function buildPayloadFromText(source, bodyText) {
  const originCfg = getOriginConfig(source.origin);
  const fromCurrency = originCfg.currency;
  const toCurrency = currencyForDestination(source.destination);
  const sendAmount = Number(source.send_amount || 1);

  let rate = extractRateFromText(bodyText, fromCurrency, toCurrency);
  const fee = extractFeeFromText(bodyText, fromCurrency);
  let amountReceived = extractAmountReceivedFromText(bodyText, toCurrency);

  if (!rate && amountReceived && sendAmount > 0) {
    rate = Number((amountReceived / sendAmount).toFixed(6));
  }

  if (!amountReceived && rate) {
    amountReceived = Number((rate * sendAmount).toFixed(3));
  }

  if (!rate || !amountReceived) return null;

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: sendAmount,
    exchange_rate: rate,
    fee,
    amount_received: Number(amountReceived.toFixed(3)),
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
  };
}

function buildResult(source, rate, fee = 0, amountReceived = null, extra = {}) {
  const sendAmount = Number(source.send_amount || 1);
  const normalizedAmountReceived =
    amountReceived !== null && amountReceived !== undefined
      ? Number(Number(amountReceived).toFixed(6))
      : Number(Number(rate).toFixed(6));

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: sendAmount,
    exchange_rate: Number(Number(rate).toFixed(6)),
    fee: Number(Number(fee || 0).toFixed(6)),
    amount_received: normalizedAmountReceived,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
    ...extra,
  };
}

async function handleLemFi(page, source) {
  const originCfg = getOriginConfig(source.origin);

  // Your latest recording works from en-gb while selecting CAD manually
  await page.goto("https://lemfi.com/en-gb/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  // Cookie flow from the new recording
  await page.getByText(/Can we use cookies to personalise your experience/i).click({ timeout: 4000 }).catch(() => {});
  await page.getByRole("button", { name: /Accept all cookies/i }).click({ timeout: 8000 }).catch(() => {});
  await page.getByRole("button", { name: /Accept all/i }).click({ timeout: 5000 }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(1500);

  // Sending currency -> CAD
  await page.getByText("GBP", { exact: true }).click().catch(async () => {
    await page.locator("div").filter({ hasText: /^[A-Z]{3}$/ }).first().click({ force: true }).catch(() => {});
  });

  let searchInput = page.getByPlaceholder("Enter currency or country");
  await searchInput.last().waitFor({ timeout: 10000 });
  await searchInput.last().click();
  await searchInput.last().fill("CAN");
  await page.waitForTimeout(1200);

  await page.locator("div").filter({ hasText: /Canada.*CAD - Canadian Dollars/i }).nth(2).click().catch(async () => {
    await page.getByText(/Canada.*CAD - Canadian Dollars/i).first().click().catch(async () => {
      await page.getByText(/Canada/i).first().click().catch(() => {});
    });
  });

  await page.waitForTimeout(1500);

  // Receiving currency -> GHS
  await page.getByText("EUR", { exact: true }).click().catch(async () => {
    const codeSelectors = page.locator("div").filter({ hasText: /^[A-Z]{3}$/ });
    const count = await codeSelectors.count();
    if (count >= 2) {
      await codeSelectors.nth(1).click({ force: true }).catch(() => {});
    }
  });

  searchInput = page.getByPlaceholder("Enter currency or country");
  await searchInput.last().waitFor({ timeout: 10000 });
  await searchInput.last().click();
  await searchInput.last().fill("GH");
  await page.waitForTimeout(1200);

  await page.getByText("GHS - Ghanian Cedis").click().catch(async () => {
    await page.getByText(/GHS - Ghanian Cedis|GHS/i).first().click().catch(() => {});
  });

  await page.waitForTimeout(3000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /CAD\s*=\s*([0-9.]+)\s*GHS/i,
    /1\s*CAD\s*=\s*([0-9.]+)\s*GHS/i,
    /CAD\s*1\s*=\s*([0-9.]+)\s*GHS/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate > 0 && candidate < 100) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    rate = extractRateFromText(bodyText, originCfg.currency, "GHS");
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract LemFi rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handleSendwave(page, source) {
  const originCfg = getOriginConfig(source.origin);

  await page.goto(`https://www.sendwave.com/${originCfg.localePath}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  }).catch(async () => {
    await page.goto("https://www.sendwave.com/en-ca", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  });

  await page.waitForTimeout(3000);

  const sendInput = page.getByRole("textbox", { name: "exchange-calculator-send-" });
  await sendInput.waitFor({ timeout: 10000 });

  await page
    .getByTestId("exchange-calculator-send-country-select")
    .getByTestId("ExpandMoreRoundedIcon")
    .click();

  await page.getByRole("combobox", { name: "Search" }).fill(originCfg.countrySearch);
  await page.getByText(new RegExp(`${originCfg.countryName}.*${originCfg.currency}`, "i")).click().catch(async () => {
    await page.getByText(new RegExp(originCfg.countryName, "i")).first().click();
  });

  await page.waitForTimeout(1000);

  await page.getByTestId("exchange-calculator-receive-country-select").click();
  await page.getByRole("combobox", { name: "Search" }).fill("ghana");
  await page.locator("div").filter({ hasText: /^GhanaGHS$/ }).click().catch(async () => {
    await page.getByText(/Ghana/i).first().click();
  });

  await page.waitForTimeout(1000);

  await sendInput.click();
  await sendInput.fill("1");

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  const payload = buildPayloadFromText(source, bodyText);
  if (!payload) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Sendwave rate. Screenshot: ${file}`);
  }
  return payload;
}

async function handleTapTap(page, source) {
  const originCfg = getOriginConfig(source.origin);

  await page.goto("https://www.taptapsend.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(3000);

  // Exact Canada -> Ghana flow from your updated recording
  await page.locator("#origin-currency").selectOption("CA-CAD-ORIGIN").catch(() => {});
  await page.waitForTimeout(1000);

  await page.locator("#destination-currency").selectOption("GH-GHS-DESTINATION").catch(() => {});
  await page.waitForTimeout(3000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /CAD\s*1\s*=\s*([0-9.]+)\s*GHS/i,
    /1\s*CAD\s*=\s*([0-9.]+)\s*GHS/i,
    /CAD\s*=\s*([0-9.]+)\s*GHS/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate > 0 && candidate < 100) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    rate = extractRateFromText(bodyText, originCfg.currency, "GHS");
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract TapTap Send rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handlePayAngel(page, source) {
  const originCfg = getOriginConfig(source.origin);

  await page.goto("https://payangel.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  await page.getByRole("button", { name: /Close dialogue/i }).click({ timeout: 5000 }).catch(() => {});
  await page.getByRole("button", { name: /^Close$/i }).click({ timeout: 5000 }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});

  await page.getByRole("link", { name: /Check today’s rate/i }).click();
  await page.waitForTimeout(2000);

  await page.getByRole("button", { name: /USD|GBP|CAD/i }).first().click().catch(() => {});
  await page.getByText(new RegExp(`^${originCfg.currency}$`, "i")).click().catch(async () => {
    await page.getByRole("option", { name: new RegExp(`^${originCfg.currency}$`, "i") }).click().catch(() => {});
  });

  await page.waitForTimeout(1000);

  const sendInput = page.getByRole("spinbutton", { name: /You send/i });
  await sendInput.waitFor({ timeout: 10000 });
  await sendInput.click({ force: true });
  await sendInput.press("Control+A").catch(() => {});
  await sendInput.fill("1");

  await page.locator(".rc-body").click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = extractRateFromText(bodyText, originCfg.currency, "GHS");

  if (!rate) {
    const patterns = [
      /([0-9]+(?:\.[0-9]+)?)\s*GHS/i,
      new RegExp(`1\\s*${originCfg.currency}\\s*=\\s*([0-9.]+)\\s*GHS`, "i"),
      new RegExp(`${originCfg.currency}\\s*1\\s*=\\s*([0-9.]+)\\s*GHS`, "i"),
    ];

    for (const regex of patterns) {
      const match = bodyText.match(regex);
      if (!match) continue;
      const candidate = parseLocaleNumber(match[1]);
      if (candidate && candidate > 0 && candidate < 10000) {
        rate = candidate;
        break;
      }
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract PayAngel rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handleRemitChoice(page, source) {
  const originCfg = getOriginConfig(source.origin);

  await page.goto("https://www.remitchoice.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("textbox", { name: /Australia|United States|United Kingdom|Canada/i }).click();
  await page.getByRole("searchbox", { name: /Search/i }).fill(originCfg.countrySearch.slice(0, 2));
  await page.waitForTimeout(1200);

  await page
    .locator('[id*="select2-sendingcountry"]')
    .getByText(new RegExp(originCfg.countryName, "i"))
    .click()
    .catch(async () => {
      await page.getByRole("option", { name: new RegExp(originCfg.countryName, "i") }).click().catch(async () => {
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
      });
    });

  await page.waitForTimeout(1200);

  await page.getByRole("textbox", { name: /Austria|Ghana/i }).click();
  await page.getByRole("searchbox", { name: /Search/i }).fill("gh");
  await page.waitForTimeout(1200);

  await page.getByRole("option", { name: /Ghana/i }).click().catch(async () => {
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
  });

  await page.waitForTimeout(1000);

  await page.getByRole("button", { name: /Proceed/i }).click();
  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    new RegExp(`Exchange Rate\\s*1\\s*${originCfg.currency}\\s*=\\s*([0-9.]+)`, "i"),
    new RegExp(`1\\s*${originCfg.currency}\\s*=\\s*([0-9.]+)\\s*GHS`, "i"),
    /\b([1-9]\d{0,3}\.\d{2,5})\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate > 0 && candidate < 10000) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract RemitChoice rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handleRizRemit(page, source) {
  await page.goto("https://rizremit.com/en-ca/send-money-to-ghana?sending=CA", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.locator("#select2-receiving-container > .d-flex").click({
    timeout: 15000,
  });

  await page.waitForTimeout(1000);

  await page.getByText("Ghana", { exact: true }).click({
    timeout: 15000,
  }).catch(async () => {
    await page.getByRole("option", { name: /Ghana/i }).click({
      timeout: 15000,
    });
  });

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /1\s*CAD\s*=\s*([0-9.]+)\s*GHS/i,
    /CAD\s*=\s*([0-9.]+)\s*GHS/i,
    /\b(8\.\d{2,5})\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;

    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 5 && candidate <= 15) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract RizRemit rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}


async function runSource(browser, source) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
  });

  try {
    let payload;

    if (source.provider === "LemFi") payload = await handleLemFi(page, source);
    else if (source.provider === "Sendwave") payload = await handleSendwave(page, source);
    else if (source.provider === "TapTap Send") payload = await handleTapTap(page, source);
    else if (source.provider === "PayAngel") payload = await handlePayAngel(page, source);
    else if (source.provider === "RemitChoice") payload = await handleRemitChoice(page, source);
    else if (source.provider === "RizRemit") payload = await handleRizRemit(page, source);
    
    else throw new Error(`No handler configured for ${source.provider}`);

    await postQuote(payload);
    console.log(`OK: ${source.provider} ${source.origin}->${source.destination}`);
  } finally {
    await page.close();
  }
}

async function main() {
  const sources = JSON.parse(fs.readFileSync("./sources-ca-gh1.json", "utf8"));
  const browser = await chromium.launch({ headless: HEADLESS });

  for (const source of sources) {
    try {
      await runSource(browser, source);
    } catch (err) {
      console.error(`FAIL: ${source.provider} - ${err.message}`);
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});