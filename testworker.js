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

async function handleVeloRemit(page, source) {
  const response = await page.goto(
    "https://veloremit.com/en",
    {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    }
  ).catch(() => null);

  await page.waitForTimeout(6000);

  const status = response?.status() || null;

  const initialText = await page
    .locator("body")
    .innerText()
    .catch(() => "");

  const blocked =
    status === 403 ||
    /403\s*ERROR/i.test(initialText) ||
    /request could not be satisfied/i.test(initialText) ||
    /request blocked/i.test(initialText) ||
    /cloudfront/i.test(initialText);

  if (blocked) {
    saveDebugText(
      source.provider,
      [
        `HTTP status: ${status || "unknown"}`,
        "VeloRemit blocked the automated browser before the calculator loaded.",
        initialText,
      ].join("\n")
    );

    const fallbackRate = parseLocaleNumber(
      process.env.VELOREMIT_CAD_GHS_RATE
    );

    if (
      fallbackRate &&
      fallbackRate >= 5 &&
      fallbackRate <= 15
    ) {
      return buildResult(
        source,
        fallbackRate,
        0,
        fallbackRate,
        {
          verification_status:
            "manual_rate_due_to_provider_block",
          verified_method:
            "veloremit_environment_fallback",
          provider_http_status: status,
        }
      );
    }

    const file = await saveScreenshot(
      page,
      source.provider
    );

    throw new Error(
      `VeloRemit returned HTTP ${status || 403}. ` +
      `The latest Playwright selectors cannot run because the page was blocked before loading. ` +
      `Add VELOREMIT_CAD_GHS_RATE to the GitHub Actions secrets or environment. ` +
      `Screenshot: ${file}`
    );
  }

  /*
   * Latest Playwright flow.
   */
  await page
    .getByRole("button", {
      name: "Currency Converter",
      exact: true,
    })
    .click({
      timeout: 15000,
      force: true,
    });

  await page.waitForTimeout(1200);

  /*
   * Do not use the generated Mantine ID because it changes
   * between runs. Select the visible GBP code instead.
   */
  const sendingCodeCandidates = page
    .locator("div:visible")
    .filter({
      hasText: /^GBP$/,
    });

  let sendingOpened = false;

  const sendingCount =
    await sendingCodeCandidates.count();

  for (
    let index = 0;
    index < sendingCount;
    index++
  ) {
    const candidate =
      sendingCodeCandidates.nth(index);

    if (
      await candidate
        .isVisible()
        .catch(() => false)
    ) {
      await candidate.click({
        timeout: 8000,
        force: true,
      });

      sendingOpened = true;
      break;
    }
  }

  if (!sendingOpened) {
    const file = await saveScreenshot(
      page,
      source.provider
    );

    throw new Error(
      `VeloRemit sending-currency control was not found. Screenshot: ${file}`
    );
  }

  await page.waitForTimeout(800);

  const canadaOptions = page
    .locator("div:visible")
    .filter({
      hasText: /^Canada - CAD$/,
    });

  let canadaSelected = false;

  const canadaCount = await canadaOptions.count();

  for (
    let index = 0;
    index < canadaCount;
    index++
  ) {
    const candidate = canadaOptions.nth(index);

    if (
      await candidate
        .isVisible()
        .catch(() => false)
    ) {
      await candidate.click({
        timeout: 10000,
        force: true,
      });

      canadaSelected = true;
      break;
    }
  }

  if (!canadaSelected) {
    const file = await saveScreenshot(
      page,
      source.provider
    );

    throw new Error(
      `VeloRemit Canada-CAD option was not found. Screenshot: ${file}`
    );
  }

  await page.waitForTimeout(1200);

  const receivingCodeCandidates = page
    .locator("div:visible")
    .filter({
      hasText: /^GHS$/,
    });

  let receivingOpened = false;

  const receivingCount =
    await receivingCodeCandidates.count();

  for (
    let index = 0;
    index < receivingCount;
    index++
  ) {
    const candidate =
      receivingCodeCandidates.nth(index);

    if (
      await candidate
        .isVisible()
        .catch(() => false)
    ) {
      await candidate.click({
        timeout: 8000,
        force: true,
      });

      receivingOpened = true;
      break;
    }
  }

  if (!receivingOpened) {
    const file = await saveScreenshot(
      page,
      source.provider
    );

    throw new Error(
      `VeloRemit receiving-currency control was not found. Screenshot: ${file}`
    );
  }

  await page.waitForTimeout(800);

  const ghanaOptions = page
    .locator("div:visible")
    .filter({
      hasText: /^Ghana - GHS$/,
    });

  let ghanaSelected = false;

  const ghanaCount = await ghanaOptions.count();

  for (
    let index = 0;
    index < ghanaCount;
    index++
  ) {
    const candidate = ghanaOptions.nth(index);

    if (
      await candidate
        .isVisible()
        .catch(() => false)
    ) {
      await candidate.click({
        timeout: 10000,
        force: true,
      });

      ghanaSelected = true;
      break;
    }
  }

  if (!ghanaSelected) {
    const file = await saveScreenshot(
      page,
      source.provider
    );

    throw new Error(
      `VeloRemit Ghana-GHS option was not found. Screenshot: ${file}`
    );
  }

  await page.waitForTimeout(6000);

  /*
   * Read the rate instead of clicking it.
   */
  const directRateText = await page
    .getByText(
      /(?:Rate\s*)?1\s*CAD\s*≈\s*[0-9]+(?:\.[0-9]+)?\s*GHS/i
    )
    .first()
    .innerText()
    .catch(() => "");

  const bodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "");

  const combinedText =
    `${directRateText}\n${bodyText}`;

  saveDebugText(
    source.provider,
    combinedText
  );

  const patterns = [
    /Rate\s*1\s*CAD\s*≈\s*([0-9]+(?:\.[0-9]+)?)\s*GHS/i,
    /1\s*CAD\s*≈\s*([0-9]+(?:\.[0-9]+)?)\s*GHS/i,
    /CAD\s*≈\s*([0-9]+(?:\.[0-9]+)?)\s*GHS/i,
    /CAD\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*GHS/i,
  ];

  let rate = null;

  for (const pattern of patterns) {
    const match = combinedText.match(pattern);

    if (!match) continue;

    const candidate = parseLocaleNumber(
      match[1]
    );

    if (
      candidate &&
      candidate >= 5 &&
      candidate <= 15
    ) {
      rate = Number(
        candidate.toFixed(6)
      );

      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(
      page,
      source.provider
    );

    throw new Error(
      `Could not extract VeloRemit CAD/GHS rate. ` +
      `Captured text: ${combinedText
        .replace(/\s+/g, " ")
        .slice(0, 400)}. ` +
      `Screenshot: ${file}`
    );
  }

  return buildResult(
    source,
    rate,
    0,
    rate,
    {
      verified_method:
        "veloremit_live_cad_ghs_rate",
    }
  );
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
    else if (source.provider === "Instarem") payload = await handleInstarem(page, source);
    else if (source.provider === "Jupay") payload = await handleJupay(page, source);
    else if (source.provider === "Paysend") payload = await handlePaysend(page, source);
    else if (source.provider === "Pesa.co") payload = await handlePesaCo(page, source);
    else if (source.provider === "SendBuddie") payload = await handleSendBuddie(page, source);
    else if (source.provider === "XE") payload = await handleXE(page, source);
    else if (source.provider === "CurrencyFlow") payload = await handleCurrencyFlow(page, source);
    else if (source.provider === "Xoom") payload = await handleXoom(page, source);
    else if (source.provider === "RemitBee") payload = await handleRemitBee(page, source);
    else if (source.provider === "ACE Money Transfer") payload = await handleAceMoneyTransfer(page, source);
    else if (source.provider === "Profee") payload = await handleProfee(page, source);
    else if (source.provider === "Pesa.co") payload = await handlePesaCo(page, source);
    else if (source.provider === "VeloRemit") payload = await handleVeloRemit(page, source);
    else if (source.provider === "AfriChange") payload = await handleAfriChange(page, source);
    else if (source.provider === "TransferGratis") payload = await handleTransferGratis(page, source);
    else if (source.provider === "BanffPay") payload = await handleBanffPay(page, source);
    else throw new Error(`No handler configured for ${source.provider}`);

    await postQuote(payload);
    console.log(`OK: ${source.provider} ${source.origin}->${source.destination}`);
  } finally {
    await page.close();
  }
}

async function main() {
  const sources = JSON.parse(fs.readFileSync("./sources-ca-gh.json", "utf8"));
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