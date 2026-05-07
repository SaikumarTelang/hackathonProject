const fs = require('fs');
const path = require('path');

const DATASET_PATH = path.join(__dirname, '..', 'industrial_manufacturing_dataset.csv');

let cachedCatalog = null;
let cachedAtMs = 0;
const CACHE_TTL_MS = 30 * 1000;

function normalizeName(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ');
}

function parseQuantity(raw) {
    const m = String(raw || '').match(/(\d+(?:\.\d+)?)/);
    if (!m) return 0;
    return Number(m[1]);
}

function parseCatalogCsv(rawCsv) {
    const lines = String(rawCsv || '')
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean);

    if (lines.length <= 1) return [];

    return lines.slice(1).map(line => {
        const [itemName, quantityRaw] = line.split(',');
        const availableQuantity = parseQuantity(quantityRaw);
        return {
            itemName: (itemName || '').trim(),
            normalizedName: normalizeName(itemName),
            availableQuantity
        };
    }).filter(x => x.itemName && x.availableQuantity > 0);
}

function loadCatalog() {
    const now = Date.now();
    if (cachedCatalog && now - cachedAtMs < CACHE_TTL_MS) {
        return cachedCatalog;
    }

    const csv = fs.readFileSync(DATASET_PATH, 'utf8');
    cachedCatalog = parseCatalogCsv(csv);
    cachedAtMs = now;
    return cachedCatalog;
}

function buildCatalogIndex(catalog) {
    const byExactName = new Map();
    for (const item of catalog) {
        byExactName.set(item.normalizedName, item);
    }
    return { byExactName };
}

function findClosestMatches(normalizedRequestName, catalog) {
    return catalog
        .filter(entry =>
            entry.normalizedName.includes(normalizedRequestName) ||
            normalizedRequestName.includes(entry.normalizedName)
        )
        .slice(0, 3)
        .map(entry => entry.itemName);
}

function verifyItems(requestedItems) {
    const catalog = loadCatalog();
    const index = buildCatalogIndex(catalog);
    const acceptedItems = [];
    const rejectedItems = [];

    for (const reqItem of requestedItems) {
        const normalizedName = normalizeName(reqItem?.name);
        const quantity = Number(reqItem?.quantity || 0);

        if (!normalizedName) {
            rejectedItems.push({
                name: reqItem?.name || 'unknown',
                quantity,
                reason: 'Missing or invalid item name'
            });
            continue;
        }

        if (!Number.isFinite(quantity) || quantity <= 0) {
            rejectedItems.push({
                name: reqItem?.name || 'unknown',
                quantity,
                reason: 'Invalid quantity (must be a number > 0)'
            });
            continue;
        }

        const catalogItem = index.byExactName.get(normalizedName);
        if (!catalogItem) {
            rejectedItems.push({
                name: reqItem.name,
                quantity,
                reason: 'Item not found in approved industrial catalog',
                suggestions: findClosestMatches(normalizedName, catalog)
            });
            continue;
        }

        if (quantity > catalogItem.availableQuantity) {
            rejectedItems.push({
                name: reqItem.name,
                quantity,
                reason: `Requested quantity exceeds available stock (${catalogItem.availableQuantity})`,
                availableQuantity: catalogItem.availableQuantity
            });
            continue;
        }

        acceptedItems.push({
            name: catalogItem.itemName,
            quantity,
            availableQuantity: catalogItem.availableQuantity
        });
    }

    return {
        passed: rejectedItems.length === 0 && acceptedItems.length > 0,
        acceptedItems,
        rejectedItems
    };
}

function serializeCatalogCsv(catalog) {
    const lines = ['Item Name,Quantity'];
    for (const item of catalog) {
        lines.push(`${item.itemName},${item.availableQuantity} units`);
    }
    return `${lines.join('\n')}\n`;
}

function saveCatalog(catalog) {
    const csv = serializeCatalogCsv(catalog);
    fs.writeFileSync(DATASET_PATH, csv, 'utf8');
    cachedCatalog = catalog;
    cachedAtMs = Date.now();
}

function verifyAndReserveItems(requestedItems) {
    const catalog = loadCatalog().map(item => ({ ...item }));
    const index = buildCatalogIndex(catalog);
    const acceptedItems = [];
    const rejectedItems = [];

    for (const reqItem of requestedItems) {
        const normalizedName = normalizeName(reqItem?.name);
        const quantity = Number(reqItem?.quantity || 0);

        if (!normalizedName) {
            rejectedItems.push({
                name: reqItem?.name || 'unknown',
                quantity,
                reason: 'Missing or invalid item name'
            });
            continue;
        }

        if (!Number.isFinite(quantity) || quantity <= 0) {
            rejectedItems.push({
                name: reqItem?.name || 'unknown',
                quantity,
                reason: 'Invalid quantity (must be a number > 0)'
            });
            continue;
        }

        const catalogItem = index.byExactName.get(normalizedName);
        if (!catalogItem) {
            rejectedItems.push({
                name: reqItem.name,
                quantity,
                reason: 'Item not found in approved industrial catalog',
                suggestions: findClosestMatches(normalizedName, catalog)
            });
            continue;
        }

        if (quantity > catalogItem.availableQuantity) {
            rejectedItems.push({
                name: reqItem.name,
                quantity,
                reason: `Requested quantity exceeds available stock (${catalogItem.availableQuantity})`,
                availableQuantity: catalogItem.availableQuantity
            });
            continue;
        }

        catalogItem.availableQuantity -= quantity;
        acceptedItems.push({
            name: catalogItem.itemName,
            quantity,
            availableQuantity: catalogItem.availableQuantity + quantity
        });
    }

    const passed = rejectedItems.length === 0 && acceptedItems.length > 0;
    if (!passed) {
        return { passed, acceptedItems, rejectedItems };
    }

    saveCatalog(catalog);
    return { passed, acceptedItems, rejectedItems };
}

function restoreReservedItems(items) {
    if (!Array.isArray(items) || items.length === 0) return;

    const catalog = loadCatalog().map(item => ({ ...item }));
    const index = buildCatalogIndex(catalog);

    for (const item of items) {
        const normalizedName = normalizeName(item?.name);
        const qty = Number(item?.quantity || 0);
        if (!normalizedName || qty <= 0) continue;

        const catalogItem = index.byExactName.get(normalizedName);
        if (catalogItem) {
            catalogItem.availableQuantity += qty;
        }
    }

    saveCatalog(catalog);
}

function getCatalogItems() {
    return loadCatalog().map(item => ({
        itemName: item.itemName,
        availableQuantity: item.availableQuantity
    }));
}

function createVerificationReply(verification) {
    if (verification.passed) {
        const summary = verification.acceptedItems
            .map(i => `${i.quantity} ${i.name}`)
            .join(', ');
        return `Verification passed. Auto-placing order for: ${summary}.`;
    }

    const reasons = verification.rejectedItems.map(item => {
        const suggestions = Array.isArray(item.suggestions) && item.suggestions.length
            ? ` Suggested: ${item.suggestions.join(', ')}.`
            : '';
        return `${item.name} (${item.quantity}): ${item.reason}.${suggestions}`;
    });

    return `Order verification failed: ${reasons.join(' ')}`;
}

module.exports = {
    verifyItems,
    verifyAndReserveItems,
    restoreReservedItems,
    getCatalogItems,
    createVerificationReply
};
