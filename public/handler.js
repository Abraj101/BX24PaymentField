// ── IMPORTANT: verify this key via crm.deal.fields in the REST explorer ──
const STORAGE_FIELD_KEY = "UF_CRM_1781355927497";
const PLAN_FIELD_KEY = "UF_CRM_1781639983191"; // hidden dropdown: Not Selected / Standard / Custom
// Enum option values for the plan dropdown (from the field definition)
const PLAN_ENUM = {
  standard: "1285", // 60/40, 3 Years, 5 Years, Full Payment
  custom: "1287", // Custom
  notSelected: "", // empty default = "not selected"
};
function planEnumValue(plan) {
  if (!plan) return PLAN_ENUM.notSelected;
  if (plan === "custom" || plan === "custom-2") return PLAN_ENUM.custom;
  return PLAN_ENUM.standard;
}

// Set to "Y" once the unit is confirmed Booked (see markBooked()).
// NOTE: verify via crm.deal.fields that this is a boolean/checkbox field —
// those store "Y"/"N" strings, not JS true/false.
const BOOKING_CONFIRMED_FIELD_KEY = "UF_CRM_1783017390988";

// Visible "Payment Plan" dropdown on the General tab — mirrors the exact plan chosen here
const PLAN_LIST_FIELD_KEY = "UF_CRM_1782057587352";
const PLAN_LIST_ENUM = {
  "60_40": "1331",
  "3_years": "1333",
  "5_years": "1335",
  full_payment: "1337",
  custom: "1339",
};
function planListEnumValue(plan) {
  return PLAN_LIST_ENUM[plan] || "";
} // '' = Not Selected

let balloonCounter = 0;
let currentDealId = null;
let saveTimeout = null;

// ── Amount Auto-Calculation (catalog plan prices → Deal amount) ───────────────
const MAX_DISCOUNT = 15; // hard cap for 60/40, 3yr, 5yr, full payment

// Keywords that identify each product price field by its (lower-cased) label
const PLAN_PRICE_KEYWORDS = {
  "60_40": ["60/40"],
  "3_years": ["3 yr", "3 years", "3yr"],
  "5_years": ["5 yr", "5 years", "5yr"],
  full_payment: ["upfront", "100%", "full payment"],
};
const PLAN_LABELS = {
  "60_40": "60/40",
  "3_years": "3 Years",
  "5_years": "5 Years",
  full_payment: "Full Payment",
  custom: "Custom",
};

// Confirmed price property IDs on the Dubai Inventory catalog (catalog-wide,
// same on every unit). Values are money fields stored as "640000.00|AED".
const PLAN_PROPERTY_OVERRIDE = {
  "60_40": 263, // Price: 60/40
  "3_years": 265, // Price: 50/10/40 (3 Yrs Post Handover)
  "5_years": 267, // Price: 50/10/40 (5 Yrs Post Handover)
  full_payment: 269, // Price: 100% Upfront Unfurnished
};

const _productCache = {}; // productId -> product object
const _propMapCache = {}; // iblockId  -> [{id, name}]
let amountTimeout = null;

function setAmountStatus(msg, isError) {
  const el = document.getElementById("amountStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.style.color = isError ? "#c62828" : "#8e99a4";
  el.style.display = msg ? "block" : "none";
  notifyResize();
}

// Promise wrapper around BX24.callMethod
function callBX(method, params) {
  return new Promise(function (resolve, reject) {
    BX24.callMethod(method, params, function (res) {
      if (res.error()) reject(res.error());
      else resolve(res.data());
    });
  });
}

// Pull a single property value off a catalog.product.get product object
function extractPropValue(product, propId) {
  const keys = [
    "property" + propId,
    "property_" + propId,
    "PROPERTY_" + propId,
    String(propId),
  ];
  for (let i = 0; i < keys.length; i++) {
    let v = product[keys[i]];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v = v[0];
    if (v && typeof v === "object")
      v = v.value !== undefined ? v.value : v.VALUE;
    const num = parseFloat(String(v).replace(/[^0-9.\-]/g, ""));
    return isNaN(num) ? null : num;
  }
  return null;
}

// Return the first array found in a response object (key-agnostic)
function firstArray(obj) {
  if (Array.isArray(obj)) return obj;
  if (obj && typeof obj === "object") {
    for (const k in obj) if (Array.isArray(obj[k])) return obj[k];
  }
  return [];
}

// List every product field across all catalogs (paginated, cached, no iblock filter)
async function fetchAllProductProperties() {
  if (_propMapCache.all) return _propMapCache.all;
  let all = [],
    lastId = 0,
    guard = 0;
  while (guard++ < 200) {
    const pdata = await callBX("catalog.productProperty.list", {
      order: { id: "ASC" },
      filter: { ">id": lastId },
      select: ["id", "name", "iblockId"],
      start: -1, // skip the COUNT query; id-keyset pagination instead of offset
    });
    const batch = firstArray(pdata);
    if (!batch.length) break; // no more pages
    all = all.concat(batch);
    lastId = Number(batch[batch.length - 1].id || batch[batch.length - 1].ID);
  }
  _propMapCache.all = all;
  console.log(
    "[PaymentWidget] product fields found:",
    all.length,
    all.map(function (p) {
      return (p.id || p.ID) + " = " + (p.name || p.NAME);
    }),
  );
  return all;
}

// Resolve the plan price for one product (with per-session caching)
async function getProductPlanPrice(productId, plan) {
  let product = _productCache[productId];
  if (!product) {
    const data = await callBX("catalog.product.get", {
      id: productId,
    });
    product = data && data.product ? data.product : data;
    _productCache[productId] = product;
    const pk = Object.keys(product).filter(function (k) {
      return /^property/i.test(k);
    });
    console.log("[PaymentWidget] product", productId, product);
    console.log(
      "[PaymentWidget] product property values:",
      pk.map(function (k) {
        return k + " = " + JSON.stringify(product[k]);
      }),
    );
  }

  // 1) Manual override wins (if configured)
  if (PLAN_PROPERTY_OVERRIDE[plan]) {
    return extractPropValue(product, PLAN_PROPERTY_OVERRIDE[plan]);
  }

  // 2) Auto-detect by field label
  const props = await fetchAllProductProperties();
  const keywords = PLAN_PRICE_KEYWORDS[plan] || [];
  let matches = props.filter(function (p) {
    const n = (p.name || p.NAME || "").toLowerCase();
    return keywords.some(function (k) {
      return n.indexOf(k) !== -1;
    });
  });
  if (matches.length > 1) {
    // prefer fields that look like a price field
    const priced = matches.filter(function (p) {
      return (p.name || p.NAME || "").toLowerCase().indexOf("price") !== -1;
    });
    if (priced.length) matches = priced;
  }
  if (!matches.length) {
    console.warn(
      '[PaymentWidget] no field matched plan "' +
        plan +
        '". Check the field list logged above, then paste the right id into ' +
        "PLAN_PROPERTY_OVERRIDE.",
    );
    return null;
  }
  return extractPropValue(product, matches[0].id || matches[0].ID);
}

// Read deal products, sum plan prices, apply capped discount, write the amount
async function recalcDealAmount() {
  const plan = document.getElementById("paymentPlan").value;
  if (!currentDealId || !plan) return;

  let disc = parseFloat(document.getElementById("discountPct").value) || 0;
  if (disc < 0) disc = 0;

  // ── Custom plan: price from the manually entered Total Amount ──
  if (plan === "custom" || plan === "custom-2") {
    const inputId = plan === "custom-2" ? "custom02TotalAmount" : "totalAmount";
    const raw = document.getElementById(inputId).value;
    const total = parseFloat(String(raw).replace(/[^0-9.\-]/g, ""));
    if (isNaN(total) || total <= 0) {
      setAmountStatus("Enter a Total Amount to set the deal amount.");
      return;
    }
    if (disc > 100) disc = 100; // no 15% cap on Custom — only sane bounds
    const finalAmount = Math.round(total * (1 - disc / 100) * 100) / 100;
    try {
      await callBX("crm.deal.update", {
        id: currentDealId,
        fields: {
          OPPORTUNITY: finalAmount,
          IS_MANUAL_OPPORTUNITY: "Y",
        },
      });
      setAmountStatus(
        "Amount set: " +
          finalAmount.toLocaleString() +
          (disc ? "  (−" + disc + "%)" : ""),
      );
    } catch (e) {
      console.error("[PaymentWidget] custom recalc error:", e);
      setAmountStatus("Could not set amount (see console).", true);
    }
    return;
  }

  // ── Catalog-priced plans (60/40, 3yr, 5yr, full payment) ──
  if (disc > MAX_DISCOUNT) disc = MAX_DISCOUNT;
  setAmountStatus("Calculating amount…");
  try {
    const rowsData = await callBX("crm.deal.productrows.get", {
      id: currentDealId,
    });
    const rows = Array.isArray(rowsData) ? rowsData : rowsData.result || [];
    if (!rows.length) {
      setAmountStatus(
        "No products on this deal — add the unit in the Products tab.",
        true,
      );
      return;
    }

    let total = 0;
    const missing = [];
    for (let i = 0; i < rows.length; i++) {
      const pid = rows[i].PRODUCT_ID || rows[i].productId;
      const qty = parseFloat(rows[i].QUANTITY || rows[i].quantity || 1) || 1;
      if (!pid) continue;
      const price = await getProductPlanPrice(pid, plan);
      if (price === null) {
        missing.push(rows[i].PRODUCT_NAME || rows[i].productName || "#" + pid);
        continue;
      }
      total += price * qty;
    }

    if (missing.length) {
      setAmountStatus(
        'No "' +
          (PLAN_LABELS[plan] || plan) +
          '" price found for: ' +
          missing.join(", "),
        true,
      );
      return;
    }

    const finalAmount = Math.round(total * (1 - disc / 100) * 100) / 100;

    await callBX("crm.deal.update", {
      id: currentDealId,
      fields: {
        OPPORTUNITY: finalAmount,
        IS_MANUAL_OPPORTUNITY: "Y",
      },
    });

    setAmountStatus(
      "Amount set: " +
        finalAmount.toLocaleString() +
        (disc ? "  (−" + disc + "%)" : ""),
    );
  } catch (e) {
    console.error("[PaymentWidget] recalcDealAmount error:", e);
    setAmountStatus("Could not calculate amount (see console).", true);
  }
}

function scheduleRecalc() {
  clearTimeout(amountTimeout);
  amountTimeout = setTimeout(recalcDealAmount, 700);
}

// Clamp the discount field for non-custom plans
function enforceDiscountCap() {
  const plan = document.getElementById("paymentPlan").value;
  const d = document.getElementById("discountPct");
  if (
    plan &&
    plan !== "custom" &&
    plan !== "custom-2" &&
    parseFloat(d.value) > MAX_DISCOUNT
  ) {
    d.value = MAX_DISCOUNT;
    setAmountStatus(
      "Max discount for this plan is " + MAX_DISCOUNT + "%.",
      true,
    );
  }
}

// ── Balloon Rows ─────────────────────────────────────────────────────────────

function addBalloonRow(position, amount) {
  balloonCounter++;
  const idx = balloonCounter;

  // Hide empty state
  const empty = document.getElementById("balloonEmpty");
  if (empty) empty.style.display = "none";

  const row = document.createElement("div");
  row.className = "balloon-row";
  row.id = `balloonRow_${idx}`;
  row.innerHTML = `
<input type="text"   class="bx-input" placeholder="Installment Number"
   data-balloon="position" value="${escapeHtml(position || "")}">
<input type="number" class="bx-input" placeholder="Amount (AED)"
   data-balloon="amount" value="${escapeHtml(amount || "")}">
<button class="btn-remove-balloon" onclick="removeBalloonRow(${idx})"
    type="button" title="Remove">&times;</button>
`;
  document.getElementById("balloonRows").appendChild(row);
  notifyResize();
  handleDataChange();
}

function removeBalloonRow(idx) {
  const row = document.getElementById(`balloonRow_${idx}`);
  if (row) row.remove();

  // Show empty state if no rows left
  const remaining = document.querySelectorAll("#balloonRows .balloon-row");
  const empty = document.getElementById("balloonEmpty");
  if (empty) empty.style.display = remaining.length === 0 ? "block" : "none";

  notifyResize();
  handleDataChange();
}

// Reset balloon rows to the empty state (used when leaving the Custom plan)
function clearBalloons() {
  document.getElementById("balloonRows").innerHTML =
    '<div class="balloon-empty" id="balloonEmpty">No balloon payments added</div>';
  balloonCounter = 0;
}

// ── Furnished toggle ──────────────────────────────────────────────────────────

function onFurnishedChange() {
  const on = document.getElementById("furnishedToggle").checked;
  document.getElementById("furnishedState").innerText = on ? "Yes" : "No";
  // Autosave is handled by the global 'change' listener.
}
function onPrivatePoolChange() {
  const on = document.getElementById("privatePoolToggle").checked;
  document.getElementById("privatePoolState").innerText = on ? "Yes" : "No";
  // Autosave is handled by the global 'change' listener.
}

// ── Plan Toggle ───────────────────────────────────────────────────────────────

// ── Plan field groups ─────────────────────────────────────────────────────────
const INSTALLMENT_PLANS = ["60_40", "3_years", "5_years"];
const CUSTOM_FIELDS = [
  "totalAmount",
  "downpaymentPct",
  "downpaymentDate",
  "dcPct",
  "dcFreq",
  "dcPayments",
  "dcStartDate",
  "possessionPct",
  "possessionDate",
  "phPct",
  "phFreq",
  "phPayments",
  "phStartDate",
];
const CUSTOM2_FIELDS = ["custom02TotalAmount"];
const INSTALLMENT_FIELDS = ["downpaymentStartDate"];
const FULLPAYMENT_FIELDS = ["paymentDate"];

function clearFields(ids) {
  ids.forEach(function (id) {
    const el = document.getElementById(id);
    if (el) el.value = "";
  });
}

function onPlanChange() {
  const plan = document.getElementById("paymentPlan").value;
  const isCustom = plan === "custom";
  const isCustom02 = plan === "custom-2";
  const isInstallment = INSTALLMENT_PLANS.indexOf(plan) !== -1;
  const isFull = plan === "full_payment";

  document.getElementById("customBlock").classList.toggle("visible", isCustom);
  document
    .getElementById("custom02Block")
    .classList.toggle("visible", isCustom02);
  document
    .getElementById("installmentBlock")
    .classList.toggle("visible", isInstallment);
  document
    .getElementById("fullPaymentBlock")
    .classList.toggle("visible", isFull);

  // Balloon payments apply to Custom plans only
  document.getElementById("balloonSection").style.display = isCustom
    ? ""
    : "none";
  if (!isCustom) clearBalloons();

  // Reset the inputs of any block that is now hidden, so storage stays clean
  if (!isCustom) clearFields(CUSTOM_FIELDS);
  if (!isCustom02) clearFields(CUSTOM2_FIELDS);
  if (!isInstallment) clearFields(INSTALLMENT_FIELDS);
  if (!isFull) clearFields(FULLPAYMENT_FIELDS);

  enforceDiscountCap();
  notifyResize();
  handleDataChange();
  scheduleRecalc(); // recalc handles both custom & catalog plans
}

// ── Collect Data ──────────────────────────────────────────────────────────────

function collectData() {
  const plan = document.getElementById("paymentPlan").value;
  console.log("[DEBUG] collectData: plan =", plan);

  // Balloon payments apply to Custom plans only
  const balloons = [];
  if (plan === "custom") {
    document
      .querySelectorAll("#balloonRows .balloon-row")
      .forEach(function (row) {
        const pos = row.querySelector('[data-balloon="position"]').value.trim();
        const amt = row.querySelector('[data-balloon="amount"]').value.trim();
        if (pos || amt) balloons.push({ position: pos, amount: amt });
      });
  }

  const data = {
    paymentPlan: plan,
    discountPct: document.getElementById("discountPct").value || "0",
    balloonPayments: balloons,
    furnished: document.getElementById("furnishedToggle").checked
      ? "Yes"
      : "No",
    privatePool: document.getElementById("privatePoolToggle").checked
      ? "Yes"
      : "No",
  };

  // Custom plan details are stored ONLY while Custom is the selected plan
  if (plan === "custom") {
    data.totalAmount = document.getElementById("totalAmount").value || "";
    data.downpaymentPct = document.getElementById("downpaymentPct").value || "";
    data.downpaymentDate =
      document.getElementById("downpaymentDate").value || "";

    // During Construction
    data.duringConstructionPct = document.getElementById("dcPct").value || "";
    data.duringConstructionFreq = document.getElementById("dcFreq").value || "";
    data.duringConstructionPayments =
      document.getElementById("dcPayments").value || "";
    data.duringConstructionStartDate =
      document.getElementById("dcStartDate").value || "";

    data.possessionPct = document.getElementById("possessionPct").value || "";
    data.possessionDate = document.getElementById("possessionDate").value || "";

    // Post Handover
    data.postHandoverPct = document.getElementById("phPct").value || "";
    data.postHandoverFreq = document.getElementById("phFreq").value || "";
    data.postHandoverPayments =
      document.getElementById("phPayments").value || "";
    data.postHandoverStartDate =
      document.getElementById("phStartDate").value || "";
  }

  // Schedule date stored only for 60/40, 3yr, 5yr (used as the schedule anchor in Booking/SPA)
  if (INSTALLMENT_PLANS.indexOf(plan) !== -1) {
    data.downpaymentStartDate =
      document.getElementById("downpaymentStartDate").value || "";
  }

  // Payment date stored only for Full Payment
  if (plan === "full_payment") {
    data.paymentDate = document.getElementById("paymentDate").value || "";
  }

  // Selected unit (persists the picker choice across reloads)
  data.unitId = selectedUnitId || "";
  data.unitName = selectedUnitName || "";

  return data;
}

// ── Autosave ──────────────────────────────────────────────────────────────────

function handleDataChange() {
  clearTimeout(saveTimeout);
  document.getElementById("saveIndicator").innerText = "Typing...";

  saveTimeout = setTimeout(function () {
    if (!currentDealId) {
      document.getElementById("saveIndicator").innerText = "No Deal context.";
      return;
    }

    document.getElementById("saveIndicator").innerText = "Saving...";
    const data = collectData();
    const payload = {};
    payload[STORAGE_FIELD_KEY] = JSON.stringify(data);
    payload[PLAN_FIELD_KEY] = planEnumValue(data.paymentPlan);
    payload[PLAN_LIST_FIELD_KEY] = planListEnumValue(data.paymentPlan);

    fetch(
      "https://bx24paymentfieldbackend.premierchoiceint.online/updateDeal",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealId: currentDealId, fields: payload }),
      },
    )
      .then(function (r) {
        return r.json().then(function (out) {
          return { ok: r.ok, out: out };
        });
      })
      .then(function (res) {
        if (res.ok) {
          document.getElementById("saveIndicator").innerText = "Saved ✓";
        } else {
          document.getElementById("saveIndicator").innerText = "Save failed ✗";
          console.error("[updateDeal] backend error:", res.out);
        }
      })
      .catch(function (e) {
        document.getElementById("saveIndicator").innerText = "Save failed ✗";
        console.error("[updateDeal] network error:", e);
      });
  }, 700);
}

// ── Populate on Load ──────────────────────────────────────────────────────────

function populateFields(rawValue) {
  if (!rawValue) return;
  try {
    const data = typeof rawValue === "string" ? JSON.parse(rawValue) : rawValue;

    // Restore the saved unit selection (dropdown is populated later by initUnitSection)
    if (data.unitId) {
      selectedUnitId = Number(data.unitId);
      selectedUnitName = data.unitName || "";
    }

    if (data.paymentPlan) {
      const p = data.paymentPlan;
      document.getElementById("paymentPlan").value = p;
      document
        .getElementById("customBlock")
        .classList.toggle("visible", p === "custom");
      document
        .getElementById("custom02Block")
        .classList.toggle("visible", p === "custom-2");
      document
        .getElementById("installmentBlock")
        .classList.toggle("visible", INSTALLMENT_PLANS.indexOf(p) !== -1);
      document
        .getElementById("fullPaymentBlock")
        .classList.toggle("visible", p === "full_payment");
      document.getElementById("balloonSection").style.display =
        p === "custom" ? "" : "none";
    }

    if (data.discountPct)
      document.getElementById("discountPct").value = data.discountPct;

    // Restore Furnished toggle (defaults to No / off)
    var furnishedOn = data.furnished === "Yes" || data.furnished === true;
    document.getElementById("furnishedToggle").checked = furnishedOn;
    document.getElementById("furnishedState").innerText = furnishedOn
      ? "Yes"
      : "No";

    // Restore Private Pool toggle (defaults to No / off)
    var poolOn = data.privatePool === "Yes" || data.privatePool === true;
    document.getElementById("privatePoolToggle").checked = poolOn;
    document.getElementById("privatePoolState").innerText = poolOn
      ? "Yes"
      : "No";

    if (
      Array.isArray(data.balloonPayments) &&
      data.balloonPayments.length > 0
    ) {
      document.getElementById("balloonRows").innerHTML = "";
      balloonCounter = 0;
      data.balloonPayments.forEach(function (b) {
        addBalloonRow(b.position, b.amount);
      });
    }

    // Restore Custom-plan inputs only when the saved plan is Custom
    if (data.paymentPlan === "custom") {
      var customMap = {
        totalAmount: "totalAmount",
        downpaymentPct: "downpaymentPct",
        downpaymentDate: "downpaymentDate",
        duringConstructionPct: "dcPct",
        duringConstructionFreq: "dcFreq",
        duringConstructionPayments: "dcPayments",
        duringConstructionStartDate: "dcStartDate",
        possessionPct: "possessionPct",
        possessionDate: "possessionDate",
        postHandoverPct: "phPct",
        postHandoverFreq: "phFreq",
        postHandoverPayments: "phPayments",
        postHandoverStartDate: "phStartDate",
      };
      Object.keys(customMap).forEach(function (key) {
        var el = document.getElementById(customMap[key]);
        if (el && data[key] !== undefined && data[key] !== "")
          el.value = data[key];
      });
    }

    // Restore Schedule Date (60/40, 3yr, 5yr)
    if (
      INSTALLMENT_PLANS.indexOf(data.paymentPlan) !== -1 &&
      data.downpaymentStartDate
    ) {
      document.getElementById("downpaymentStartDate").value =
        data.downpaymentStartDate;
    }

    // Restore Payment Date (Full Payment)
    if (data.paymentPlan === "full_payment" && data.paymentDate) {
      document.getElementById("paymentDate").value = data.paymentDate;
    }
  } catch (e) {
    console.error("populateFields parse error:", e);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function notifyResize() {
  if (window.BX24) BX24.fitWindow();
}

// Interpret a Bitrix boolean/checkbox UF value regardless of how it comes back
// (string "Y"/"N", real boolean, or "1"/"0")
function isTrueValue(v) {
  return v === "Y" || v === true || v === "1" || v === 1;
}

let _formLocked = false; // true once booking is confirmed — blocks all further edits

// ── Unit selection, status & gating ───────────────────────────────────────────
//
// CONFIG — adjust here only if names/ids change in Bitrix.
const UNIT_STATUS_PROP_ID = 99; // PROPERTY_99 (unit status list field)
const UNIT_SECTION_NAME = "Dubai Inventory"; // catalog section holding the units
let UNIT_SECTION_ID = 53; // Dubai Inventory section (resolved)
let UNIT_IBLOCK_ID = 15; // CRM Product Catalog iblock (resolved)
const UNIT_PIPELINE_STAGE_BOOKING = "Sales Booking"; // stage where a unit may be attached
const ST_AVAILABLE = "Available",
  ST_BOOKED = "Booked",
  ST_SOLD = "Sold",
  ST_RESERVED = "Reserved";

let _statusEnum = null; // { byId:{id:label}, byLabel:{label:id} }
let _unitCatalog = []; // [{ id, name, status }]
let _unitStatusById = {}; // id -> status label
let _currentStageName = "";
let _isBookingStage = false;
let _attachedUnitId = null; // unit currently in THIS deal's product rows
let selectedUnitId = null; // picker choice (persisted into the deal JSON)
let selectedUnitName = "";
let _suppressSave = false; // avoid autosave while restoring state on load

// Resolve the four enum values of PROPERTY_99 → their value ids (needed to read/write)
async function resolveStatusEnum() {
  if (_statusEnum) return _statusEnum;
  const data = await callBX("catalog.productPropertyEnum.list", {
    select: ["id", "propertyId", "value"],
    filter: { propertyId: UNIT_STATUS_PROP_ID },
  });
  const list =
    data && data.productPropertyEnums
      ? data.productPropertyEnums
      : firstArray(data);
  const byId = {},
    byLabel = {};
  list.forEach(function (r) {
    const id = Number(r.id || r.ID);
    const val = String(r.value || r.VALUE || "");
    byId[id] = val;
    byLabel[val.toLowerCase()] = id;
  });
  _statusEnum = { byId: byId, byLabel: byLabel };
  return _statusEnum;
}

// Turn a raw PROPERTY_99 value (id, {value}, or text) into its label
function statusLabelFromRaw(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) raw = raw[0];
  if (raw && typeof raw === "object") {
    raw =
      raw.value !== undefined
        ? raw.value
        : raw.valueId !== undefined
          ? raw.valueId
          : raw.VALUE;
  }
  const n = Number(raw);
  if (!isNaN(n) && _statusEnum && _statusEnum.byId[n])
    return _statusEnum.byId[n];
  return raw == null ? null : String(raw);
}

// Resolve the catalog iblockId (REQUIRED by catalog.product.list) and, if possible,
// the "Dubai Inventory" section id. Override either via the CONFIG constants above.
async function resolveCatalogIds() {
  if (UNIT_IBLOCK_ID && (UNIT_SECTION_ID || UNIT_SECTION_ID === 0)) return;
  try {
    const cats = await callBX("catalog.catalog.list", {});
    const clist = cats && cats.catalogs ? cats.catalogs : firstArray(cats);
    let ids = [];
    clist.forEach(function (c) {
      [
        "iblockId",
        "productIblockId",
        "offerIblockId",
        "IBLOCK_ID",
        "id",
      ].forEach(function (k) {
        if (c[k] != null) ids.push(Number(c[k]));
      });
    });
    ids = ids.filter(function (v, i, a) {
      return a.indexOf(v) === i;
    });

    // Try to locate the Dubai Inventory section within a candidate iblock.
    for (let i = 0; i < ids.length; i++) {
      try {
        const secs = await callBX("catalog.section.list", {
          select: ["id", "name", "iblockId"],
          filter: { iblockId: ids[i] },
        });
        const slist = secs && secs.sections ? secs.sections : firstArray(secs);
        const m = slist.find(function (s) {
          return (
            String(s.name || s.NAME || "")
              .toLowerCase()
              .indexOf(UNIT_SECTION_NAME.toLowerCase()) !== -1
          );
        });
        if (m) {
          if (!UNIT_IBLOCK_ID) UNIT_IBLOCK_ID = ids[i];
          if (!UNIT_SECTION_ID) UNIT_SECTION_ID = Number(m.id || m.ID);
          return;
        }
      } catch (e) {
        /* try next iblock */
      }
    }
    // No section match — fall back to the first catalog iblock (lists all its products).
    if (!UNIT_IBLOCK_ID && ids.length) UNIT_IBLOCK_ID = ids[0];
  } catch (e) {
    console.warn(
      "[Unit] catalog id auto-resolve failed. Set UNIT_IBLOCK_ID " +
        "(and optionally UNIT_SECTION_ID) at the top of the unit script.",
      e,
    );
  }
}

// Load all units from the custom backend (replaces the direct catalog.product.list call)
async function loadUnits() {
  await resolveStatusEnum();

  const resp = await fetch(
    "https://bx24paymentfieldbackend.premierchoiceint.online/getAllProducts",
  );
  if (!resp.ok) {
    throw new Error("Failed to fetch units: " + resp.status);
  }
  const out = await resp.json();
  const all = Array.isArray(out) ? out : out.data || [];

  _unitCatalog = all.map(function (p) {
    const raw =
      p["PROPERTY_" + UNIT_STATUS_PROP_ID] ??
      p["property" + UNIT_STATUS_PROP_ID];
    const status = statusLabelFromRaw(raw);
    const rec = {
      id: Number(p.ID ?? p.id),
      name: String(p.NAME ?? p.name ?? "#" + (p.ID ?? p.id)),
      status: status,
    };
    _unitStatusById[rec.id] = status;
    return rec;
  });
  return _unitCatalog;
}

function populateUnitDropdown() {
  const sel = document.getElementById("unitSelect");
  sel.innerHTML = '<option value="">— Select unit —</option>';
  _unitCatalog
    .slice()
    .sort(function (a, b) {
      return a.name.localeCompare(b.name);
    })
    .forEach(function (u) {
      const o = document.createElement("option");
      o.value = u.id;
      o.textContent = u.name;
      sel.appendChild(o);
    });
  if (selectedUnitId) sel.value = String(selectedUnitId);
}

function badgeClassFor(label) {
  const l = (label || "").toLowerCase();
  if (l === "available") return "available";
  if (l === "reserved") return "reserved";
  if (l === "booked") return "booked";
  if (l === "sold") return "sold";
  return "empty";
}

function setPaymentLocked(locked) {
  const body = document.getElementById("paymentBody");
  if (body) body.classList.toggle("locked", !!locked);
}

// Locks EVERYTHING once a booking is confirmed: the unit picker, both action
// buttons, and the payment fields. Once locked, nothing in the widget is
// editable — used both right after "Mark Booked" succeeds and on initial
// render when the record already has BOOKING_CONFIRMED_FIELD_KEY = true.
function lockEntireForm(locked, message) {
  _formLocked = locked;
  setPaymentLocked(locked);

  const unitSelect = document.getElementById("unitSelect");
  if (unitSelect) unitSelect.disabled = !!locked;

  const attachBtn = document.getElementById("attachBtn");
  const bookedBtn = document.getElementById("markBookedBtn");
  if (locked) {
    if (attachBtn) attachBtn.style.display = "none";
    if (bookedBtn) bookedBtn.style.display = "none";
  }

  if (message !== undefined) showGateMsg(message, false);
  notifyResize();
}

function showGateMsg(msg, isError) {
  const el = document.getElementById("unitGateMsg");
  el.textContent = msg || "";
  el.style.color = isError ? "#c62828" : "#8e99a4";
  el.style.display = msg ? "block" : "none";
  notifyResize();
}

// Core gating: decide what to show/allow for the chosen unit.
//
// Three distinct states now drive the UI:
//   1. Not attached to this deal            -> show "Attach Unit" (if available + Booking stage)
//   2. Attached to this deal, not yet Booked -> show "Mark Booked"
//   3. Attached to this deal AND Booked      -> no buttons, payments unlocked
function onUnitChange() {
  const sel = document.getElementById("unitSelect");
  const id = sel.value ? Number(sel.value) : null;
  const badge = document.getElementById("unitStatusBadge");
  const attachBtn = document.getElementById("attachBtn");
  const bookedBtn = document.getElementById("markBookedBtn");

  // Reset both buttons to their default state before re-evaluating
  attachBtn.style.display = "none";
  attachBtn.disabled = false;
  attachBtn.textContent = "Attach Unit";
  bookedBtn.style.display = "none";
  bookedBtn.disabled = false;
  bookedBtn.textContent = "Mark Booked";

  if (!id) {
    selectedUnitId = null;
    selectedUnitName = "";
    badge.className = "status-badge empty";
    badge.textContent = "—";
    if (!_formLocked) {
      setPaymentLocked(true);
      showGateMsg("Select a unit to enter payment details.", false);
    }
    if (!_suppressSave) handleDataChange();
    return;
  }

  selectedUnitId = id;
  const opt = sel.options[sel.selectedIndex];
  selectedUnitName = opt ? opt.textContent : "";
  const status = _unitStatusById[id] || null;
  badge.className = "status-badge " + badgeClassFor(status);
  badge.textContent = status || "—";

  // Booking already confirmed — badge/value are painted above, but skip all
  // gating logic entirely so neither button can be revealed.
  if (_formLocked) {
    if (!_suppressSave) handleDataChange();
    return;
  }

  const isOurs = _attachedUnitId && Number(_attachedUnitId) === id;
  const sl = (status || "").toLowerCase();

  if (isOurs && sl === "booked") {
    // Fully attached AND booked — payments unlocked, no action needed
    setPaymentLocked(false);
    showGateMsg("", false);
  } else if (isOurs) {
    // Attached to this deal but the status hasn't been flipped to Booked yet
    setPaymentLocked(false);
    showGateMsg(
      'Unit attached. Click "Mark Booked" to lock the status.',
      false,
    );
    bookedBtn.style.display = "block";
  } else if (sl === "available") {
    setPaymentLocked(false);
    showGateMsg("", false);
    if (_isBookingStage) {
      attachBtn.style.display = "block";
    } else {
      showGateMsg(
        'Unit is available. It can be attached once the deal reaches "Sales Booking".',
        false,
      );
    }
  } else if (sl === "booked" || sl === "sold") {
    setPaymentLocked(true);
    showGateMsg(
      "This unit is " +
        status +
        " on another deal and cannot be used. Please choose an available unit.",
      true,
    );
  } else if (sl === "reserved") {
    setPaymentLocked(true);
    showGateMsg("This unit is Reserved and cannot be used right now.", true);
  } else {
    setPaymentLocked(true);
    showGateMsg(
      "Unit status could not be read. Please choose another unit.",
      true,
    );
  }
  if (!_suppressSave) handleDataChange();
}

// Step 1: Attach the chosen unit to this deal's product rows.
// This ONLY adds the product row — it does NOT touch the catalog status.
// NOTE: because this no longer calls the backend's atomic /updateProduct
// check, two deals could theoretically attach the same "Available" unit
// before either calls Mark Booked. If that matters for your workflow,
// add a server-side guard (or re-check status here) before allowing attach.
async function attachUnit() {
  if (!currentDealId || !selectedUnitId) return;
  const btn = document.getElementById("attachBtn");
  btn.disabled = true;
  btn.textContent = "Attaching…";
  try {
    // This widget enforces "exactly one unit product row per deal". Rather
    // than trying to remove just the row we think is currently attached
    // (which breaks if the deal ever picked up a stray extra row from
    // elsewhere), we replace the ENTIRE product-rows array with just the
    // newly selected unit. This also self-heals any deal that already has
    // leftover/duplicate rows from before this fix.
    await callBX("crm.deal.productrows.set", {
      id: currentDealId,
      rows: [
        {
          PRODUCT_ID: selectedUnitId,
          QUANTITY: 1,
        },
      ],
    });

    _attachedUnitId = selectedUnitId;
    handleDataChange();
    if (typeof scheduleRecalc === "function") scheduleRecalc();

    // Re-run gating so the Mark Booked button now appears
    onUnitChange();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Attach Unit";
    showGateMsg("Could not attach the unit. Please retry.", true);
    console.error("[attachUnit]", e);
  }
  notifyResize();
}

// Step 2: Mark the already-attached unit as Booked.
// Calls the backend so the Available → Booked flip is authoritative/atomic
// server-side (re-checked against other deals) rather than trusted from the client.
async function markBooked() {
  if (!currentDealId || !selectedUnitId) return;
  if (!_attachedUnitId || Number(_attachedUnitId) !== Number(selectedUnitId)) {
    showGateMsg("Attach the unit to this deal before marking it Booked.", true);
    return;
  }
  const btn = document.getElementById("markBookedBtn");
  btn.disabled = true;
  btn.textContent = "Marking Booked…";
  try {
    const resp = await fetch(
      "https://bx24paymentfieldbackend.premierchoiceint.online/updateProduct",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: String(selectedUnitId),
        }),
      },
    );
    const out = await resp.json();
    const badge = document.getElementById("unitStatusBadge");

    if (out.success) {
      _unitStatusById[selectedUnitId] = ST_BOOKED;
      badge.className = "status-badge booked";
      badge.textContent = ST_BOOKED;
      handleDataChange();

      // Flag the deal itself as confirmed-booked
      try {
        const confirmFields = {};
        confirmFields[BOOKING_CONFIRMED_FIELD_KEY] = "Y";
        await callBX("crm.deal.update", {
          id: currentDealId,
          fields: confirmFields,
        });
        lockEntireForm(
          true,
          "Booking confirmed. This record is now locked and cannot be edited.",
        );
      } catch (e) {
        console.error("[markBooked] booking-confirmed field update error:", e);
        // Status is booked either way — lock the form regardless, but flag the field issue
        lockEntireForm(
          true,
          "Unit marked Booked, but the confirmation field failed to update (see console). Record is locked.",
        );
      }
    } else {
      btn.disabled = false;
      btn.textContent = "Mark Booked";
      showGateMsg(
        "Could not mark the unit Booked" +
          (out.message ? ": " + out.message : "") +
          ".",
        true,
      );
    }
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "Mark Booked";
    showGateMsg(
      "Network error while marking the unit Booked. Please retry.",
      true,
    );
    console.error("[markBooked]", e);
  }
  notifyResize();
}

// Resolve this deal's stage NAME so we know if it's "Sales Booking"
async function resolveDealStage(dealData) {
  try {
    const catId = dealData.CATEGORY_ID != null ? dealData.CATEGORY_ID : 0;
    const entityId =
      String(catId) !== "0" ? "DEAL_STAGE_" + catId : "DEAL_STAGE";
    const stages = await callBX("crm.status.list", {
      order: { SORT: "ASC" },
      filter: { ENTITY_ID: entityId },
    });
    const list = firstArray(stages);
    const norm = function (s) {
      s = String(s || "");
      const i = s.indexOf(":");
      return i >= 0 ? s.slice(i + 1) : s;
    };
    const cur = list.find(function (s) {
      return norm(s.STATUS_ID) === norm(dealData.STAGE_ID);
    });
    _currentStageName = cur ? String(cur.NAME || "") : "";
    _isBookingStage =
      _currentStageName.toLowerCase() ===
      UNIT_PIPELINE_STAGE_BOOKING.toLowerCase();
  } catch (e) {
    console.warn("[Unit] stage resolve failed", e);
    _isBookingStage = false;
  }
}

// Called from BX24.init once the deal is loaded
async function initUnitSection(dealData) {
  try {
    await resolveDealStage(dealData);

    const sel = document.getElementById("unitSelect");
    sel.innerHTML = '<option value="">Loading...</option>';
    sel.disabled = true;

    await loadUnits();
    populateUnitDropdown();
    sel.disabled = _formLocked; // preserve an earlier lock instead of always re-enabling

    // Which unit is currently attached to THIS deal (native product rows)?
    try {
      const rowsData = await callBX("crm.deal.productrows.get", {
        id: currentDealId,
      });
      const rows = firstArray(rowsData);
      if (rows.length)
        _attachedUnitId = Number(rows[0].PRODUCT_ID || rows[0].productId);
      if (rows.length > 1) {
        console.warn(
          "[Unit] deal " +
            currentDealId +
            " has " +
            rows.length +
            " product rows — only the first is tracked as the attached unit. " +
            "Clicking Attach will replace ALL of them with just the selected unit.",
        );
      }
    } catch (e) {
      console.warn("[Unit] productrows.get failed", e);
    }

    // Prefer the saved picker choice; fall back to the attached unit
    if (selectedUnitId == null && _attachedUnitId)
      selectedUnitId = _attachedUnitId;

    if (selectedUnitId && _unitStatusById[selectedUnitId] == null) {
      // Selected unit wasn't in the section list — fetch its status directly
      try {
        const g = await callBX("catalog.product.get", {
          id: selectedUnitId,
        });
        const pr = g && g.product ? g.product : g;
        _unitStatusById[selectedUnitId] = statusLabelFromRaw(
          pr["property" + UNIT_STATUS_PROP_ID],
        );
        if (
          !document.querySelector(
            '#unitSelect option[value="' + selectedUnitId + '"]',
          )
        ) {
          const o = document.createElement("option");
          o.value = selectedUnitId;
          o.textContent = selectedUnitName || "#" + selectedUnitId;
          document.getElementById("unitSelect").appendChild(o);
        }
      } catch (e) {
        console.warn("[Unit] status fetch for selected unit failed", e);
      }
    }
    if (selectedUnitId)
      document.getElementById("unitSelect").value = String(selectedUnitId);

    _suppressSave = true;
    onUnitChange(); // paint badge + apply gating from restored/attached state
    _suppressSave = false;
  } catch (e) {
    console.error("[Unit] init failed", e);
    setPaymentLocked(false); // fail open so existing deals stay usable
  }
  notifyResize();
}

// ── BX24 Init ─────────────────────────────────────────────────────────────────

BX24.init(function () {
  const info = BX24.placement.info();
  currentDealId =
    info && info.options ? info.options.ID || info.options.id || null : null;

  if (currentDealId) {
    BX24.callMethod("crm.deal.get", { id: currentDealId }, function (result) {
      if (result.error()) {
        document.getElementById("saveIndicator").innerText = "Load error ✗";
        console.error("crm.deal.get error:", result.error());
      } else {
        const dealData = result.data();
        if (dealData && dealData[STORAGE_FIELD_KEY]) {
          populateFields(dealData[STORAGE_FIELD_KEY]);
        }
        document.getElementById("saveIndicator").innerText = "Ready ✓";

        // Lock immediately if this deal was already confirmed Booked —
        // don't wait on the unit-loading round trip (loadUnits/backend fetch)
        // before applying the lock. initUnitSection() still runs afterward
        // to populate the dropdown/badge for display, but it respects
        // _formLocked and won't re-enable anything.
        if (isTrueValue(dealData[BOOKING_CONFIRMED_FIELD_KEY])) {
          lockEntireForm(
            true,
            "Booking confirmed. This record is locked and cannot be edited.",
          );
        }

        notifyResize();
        initUnitSection(dealData); // load units, resolve stage, apply gating
      }
    });
  } else {
    document.getElementById("saveIndicator").innerText = "No Deal context.";
    console.warn("placement.info() returned no ID:", info);
  }

  notifyResize();
});

document.addEventListener("input", handleDataChange);
document.addEventListener("change", handleDataChange);

// Discount field: enforce the 15% cap and re-calculate the amount
document.getElementById("discountPct").addEventListener("input", function () {
  enforceDiscountCap();
  scheduleRecalc();
});

// Custom Total Amount: re-calculate the deal amount as it's typed
document
  .getElementById("totalAmount")
  .addEventListener("input", scheduleRecalc);

document
  .getElementById("custom02TotalAmount")
  .addEventListener("input", scheduleRecalc);
