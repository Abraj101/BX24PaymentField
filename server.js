const express = require("express");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3000;

// ── Backend credential ────────────────────────────────────────────────────────
// Incoming webhook BASE url, e.g. https://pcicrm.bitrix24.com/rest/11/TOKEN/
// Set this in Dokploy env as B24_WEBHOOK. Trailing slash is optional.
const B24_WEBHOOK = (process.env.B24_WEBHOOK || "").replace(/\/+$/, "");
// Optional hardening: only handle events from this portal domain.
const B24_EXPECTED_DOMAIN = process.env.B24_EXPECTED_DOMAIN || "";

// ── Config (adjust only if names change in Bitrix) ────────────────────────────
const STATUS_PROPERTY_ID = 99; // PROPERTY_99 on the unit
const PIPELINE_NAME = "Dubai Sales"; // deal funnel (category) name
const STAGE_BOOKING = "Sales Booking"; // -> unit becomes Booked
const STAGE_SIGNATURE = "Booking Under Signature"; // -> unit becomes Sold
const ST_AVAILABLE = "Available";
const ST_BOOKED = "Booked";
const ST_SOLD = "Sold";

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // parses Bitrix event body (data[FIELDS][ID])

if (!B24_WEBHOOK) {
  console.warn(
    "[WARN] B24_WEBHOOK is not set — /book and /event will fail until it is configured.",
  );
}

// ── REST helper (server-side, authenticates via the incoming webhook) ─────────
async function callWebhook(method, params) {
  if (!B24_WEBHOOK) throw new Error("B24_WEBHOOK not configured");
  const resp = await fetch(B24_WEBHOOK + "/" + method + ".json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params || {}),
  });
  const data = await resp.json();
  if (data.error)
    throw new Error(
      method + ": " + data.error + " " + (data.error_description || ""),
    );
  return data.result;
}

function firstArray(obj) {
  if (Array.isArray(obj)) return obj;
  if (obj && typeof obj === "object")
    for (const k in obj) if (Array.isArray(obj[k])) return obj[k];
  return [];
}

function normStage(s) {
  s = String(s || "");
  const i = s.indexOf(":");
  return i >= 0 ? s.slice(i + 1) : s; // "C3:BOOKING" -> "BOOKING"
}

// ── Cached lookups ────────────────────────────────────────────────────────────
let _enumCache = null; // { byLabel:{label:id}, byId:{id:label} }
async function getStatusEnum() {
  if (_enumCache) return _enumCache;
  const res = await callWebhook("catalog.productPropertyEnum.list", {
    select: ["id", "propertyId", "value"],
    filter: { propertyId: STATUS_PROPERTY_ID },
  });
  const list =
    res && res.productPropertyEnums
      ? res.productPropertyEnums
      : firstArray(res);
  const byLabel = {},
    byId = {};
  list.forEach(function (r) {
    const id = Number(r.id || r.ID);
    const val = String(r.value || r.VALUE || "");
    byLabel[val.toLowerCase()] = id;
    byId[id] = val;
  });
  _enumCache = { byLabel: byLabel, byId: byId };
  return _enumCache;
}

let _pipeCache = null; // { categoryId, byStatusNorm:{ CODE:{statusId,name,semantics} } }
async function getPipeline() {
  if (_pipeCache) return _pipeCache;
  // 1) find the category (funnel) id by name
  const cats = await callWebhook("crm.category.list", { entityTypeId: 2 });
  const clist = cats && cats.categories ? cats.categories : firstArray(cats);
  const match =
    clist.find(function (c) {
      return (
        String(c.name || c.NAME || "")
          .trim()
          .toLowerCase() === PIPELINE_NAME.toLowerCase()
      );
    }) ||
    clist.find(function (c) {
      return (
        String(c.name || c.NAME || "")
          .toLowerCase()
          .indexOf(PIPELINE_NAME.toLowerCase()) !== -1
      );
    });
  const categoryId = match ? Number(match.id != null ? match.id : match.ID) : 0;
  const entityId = categoryId ? "DEAL_STAGE_" + categoryId : "DEAL_STAGE";
  // 2) list the funnel's stages
  const stages = await callWebhook("crm.status.list", {
    order: { SORT: "ASC" },
    filter: { ENTITY_ID: entityId },
  });
  const slist = firstArray(stages);
  const byStatusNorm = {};
  slist.forEach(function (s) {
    const rec = {
      statusId: String(s.STATUS_ID || ""),
      name: String(s.NAME || ""),
      semantics: String((s.EXTRA && s.EXTRA.SEMANTICS) || s.SEMANTICS || ""),
    };
    byStatusNorm[normStage(rec.statusId)] = rec;
  });
  _pipeCache = { categoryId: categoryId, byStatusNorm: byStatusNorm };
  return _pipeCache;
}

// ── Product status read / write ───────────────────────────────────────────────
function extractPropRaw(product, propId) {
  const keys = [
    "property" + propId,
    "PROPERTY_" + propId,
    "property_" + propId,
    String(propId),
  ];
  for (let i = 0; i < keys.length; i++) {
    let v = product[keys[i]];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v = v[0];
    if (v && typeof v === "object") {
      v =
        v.value !== undefined
          ? v.value
          : v.valueId !== undefined
            ? v.valueId
            : v.VALUE;
    }
    return v;
  }
  return null;
}

async function getUnitStatusLabel(productId) {
  const data = await callWebhook("catalog.product.get", { id: productId });
  const product = data && data.product ? data.product : data;
  const raw = extractPropRaw(product, STATUS_PROPERTY_ID);
  if (raw == null) return null;
  const en = await getStatusEnum();
  const n = Number(raw);
  if (!isNaN(n) && en.byId[n]) return en.byId[n];
  return String(raw);
}

async function setUnitStatus(productId, label) {
  const en = await getStatusEnum();
  const enumId = en.byLabel[String(label).toLowerCase()];
  if (!enumId) {
    throw new Error(
      'Status "' +
        label +
        '" not in PROPERTY_' +
        STATUS_PROPERTY_ID +
        " enum (found: " +
        Object.keys(en.byLabel).join(", ") +
        ")",
    );
  }
  const fields = {};
  fields["property" + STATUS_PROPERTY_ID] = enumId;
  await callWebhook("catalog.product.update", {
    id: productId,
    fields: fields,
  });
  return enumId;
}

// ── Route: attach + book (called by the widget's "Attach" button) ─────────────
app.post("/book", async (req, res) => {
  try {
    const dealId = req.body.dealId;
    const productId = req.body.productId;
    if (!dealId || !productId)
      return res
        .status(400)
        .json({ ok: false, error: "dealId and productId required" });

    // 1) atomic re-check: is the unit still Available?
    const label = await getUnitStatusLabel(productId);
    if (label && label.toLowerCase() !== ST_AVAILABLE.toLowerCase()) {
      return res.json({ ok: false, reason: "not_available", status: label });
    }

    // 2) defense: confirm the deal is at "Sales Booking"
    const deal = await callWebhook("crm.deal.get", { id: dealId });
    const pipe = await getPipeline();
    const stageRec = pipe.byStatusNorm[normStage(deal.STAGE_ID)];
    const stageName = stageRec ? stageRec.name : "";
    if (stageName.toLowerCase() !== STAGE_BOOKING.toLowerCase()) {
      return res.json({ ok: false, reason: "wrong_stage", stage: stageName });
    }

    // 3) attach to the native product rows (one unit per deal → full replace)
    await callWebhook("crm.deal.productrows.set", {
      id: dealId,
      rows: [{ PRODUCT_ID: Number(productId), PRICE: 0, QUANTITY: 1 }],
    });

    // 4) flip status → Booked
    await setUnitStatus(productId, ST_BOOKED);

    return res.json({ ok: true, status: ST_BOOKED });
  } catch (e) {
    console.error("[/book] error:", e.message);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Route: stage-driven automation (ONCRMDEALUPDATE handler) ──────────────────
app.post("/event", (req, res) => {
  res.sendStatus(200); // ACK fast; Bitrix throttles slow handlers
  processDealEvent(req.body).catch(function (e) {
    console.error("[/event] error:", e.message);
  });
});

async function processDealEvent(body) {
  body = body || {};
  if (String(body.event || "").toUpperCase() !== "ONCRMDEALUPDATE") return;
  if (
    B24_EXPECTED_DOMAIN &&
    body.auth &&
    body.auth.domain &&
    body.auth.domain !== B24_EXPECTED_DOMAIN
  ) {
    console.warn("[/event] ignored — domain mismatch:", body.auth.domain);
    return;
  }
  const dealId = body.data && body.data.FIELDS && body.data.FIELDS.ID;
  if (!dealId) return;

  const deal = await callWebhook("crm.deal.get", { id: dealId });
  const pipe = await getPipeline();

  // only touch deals in the target pipeline
  if (String(deal.CATEGORY_ID) !== String(pipe.categoryId)) return;

  const stageRec = pipe.byStatusNorm[normStage(deal.STAGE_ID)];
  if (!stageRec) return;
  const stageName = (stageRec.name || "").toLowerCase();
  const semantics = (stageRec.semantics || "").toLowerCase();

  // which unit is attached?
  const rows = await callWebhook("crm.deal.productrows.get", { id: dealId });
  const rlist = firstArray(rows);
  const productId = rlist.length
    ? rlist[0].PRODUCT_ID || rlist[0].productId
    : null;
  if (!productId) return;

  const cur = await getUnitStatusLabel(productId);
  const curLabel = (cur || "").toLowerCase();

  let target = null;
  if (semantics === "failure") {
    target = ST_AVAILABLE; // deal Lost → free the unit
  } else if (stageName === STAGE_SIGNATURE.toLowerCase()) {
    target = ST_SOLD; // Signature → Sold
  } else if (stageName === STAGE_BOOKING.toLowerCase()) {
    if (curLabel === ST_AVAILABLE.toLowerCase()) target = ST_BOOKED; // promote only; never demote
  }
  if (!target) return;
  if (curLabel === target.toLowerCase()) return; // idempotent

  await setUnitStatus(productId, target);
  console.log(
    "[/event] deal " +
      dealId +
      ' @ "' +
      stageRec.name +
      '" → unit ' +
      productId +
      " = " +
      target,
  );
}

// ── Static + app screens ──────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

app.all("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.all("/handler.html", (req, res) => {
  res.sendFile(path.join(__dirname, "handler.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
