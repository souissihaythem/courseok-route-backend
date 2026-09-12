/**
 * Analysis packs — source of truth for SumUp checkout amounts.
 * 200 analyses / 1 € … 4000 / 20 €
 */
const PACKS = [];
for (let n = 1; n <= 20; n++) {
  const analyses = 200 * n;
  PACKS.push({
    id: `pack_${analyses}`,
    analyses,
    priceEuros: n,
    amountCents: n * 100,
    label: `${analyses} analyses`,
  });
}

function getPack(packId) {
  return PACKS.find((p) => p.id === String(packId || "").trim()) || null;
}

module.exports = { PACKS, getPack };
