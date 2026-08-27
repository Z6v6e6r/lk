import { isDeepStrictEqual } from "node:util";

const ROUTER_ID = "8f7bd5b482fe9763";
const ROUTER_NAME = "Route Viva split payment";
const BASE_WIRES = Object.freeze([
  Object.freeze(["ee7ba8cdd68bdf74"]),
  Object.freeze(["802af8a1810db60f"]),
  Object.freeze(["ef42932e1ba864b8"]),
  Object.freeze(["lk_subscription_booking_http_20260804"]),
]);

export const MANAGED_SUBSCRIPTION_ROUTER_CONTRACTS = Object.freeze([
  Object.freeze({
    outputs: 4,
    wires: BASE_WIRES,
    funcSha256: Object.freeze([
      "aba5f45ce45208997b188d5292194c49d357452673eee7b937650ec998348a04",
      "a311b8ddc6e7752ee87deb278b25ac2ddc8fb9af8b273deea66b07702ac571c8",
    ]),
  }),
  Object.freeze({
    outputs: 5,
    wires: Object.freeze([
      ...BASE_WIRES,
      Object.freeze(["legacy_payment_confirm_canonical_prepare_20260816"]),
    ]),
    funcSha256: Object.freeze([
      "34ba99f50ca025095d464aadd47af0aa1352a1679482f032abc30846b5fa1c80",
    ]),
    managedActionCandidateSha256:
      "a9477e5e76419cc7317edb96cdbeda94a6745d07cb9aa0c5f1e82b2cebde2611",
  }),
  Object.freeze({
    outputs: 5,
    wires: Object.freeze([
      ...BASE_WIRES,
      Object.freeze(["legacy_payment_confirm_canonical_prepare_20260816"]),
    ]),
    funcSha256: Object.freeze([
      "2e16ee303fcae77e0d09f2a527d0fd77378bc8ea6af4027ef9636ebf8f36813f",
    ]),
    managedActionCandidateSha256:
      "953c84c1885b77b4f7b7e826430b49a97e14656fa2a53e135aa35a93f72fe53d",
  }),
  Object.freeze({
    outputs: 5,
    wires: Object.freeze([
      ...BASE_WIRES,
      Object.freeze(["legacy_payment_confirm_canonical_prepare_20260816"]),
    ]),
    funcSha256: Object.freeze([
      "a9477e5e76419cc7317edb96cdbeda94a6745d07cb9aa0c5f1e82b2cebde2611",
      "953c84c1885b77b4f7b7e826430b49a97e14656fa2a53e135aa35a93f72fe53d",
      "892ad51fcb8f2be2a194661e04f9c775d4345fea153e5dbc3758bd40967101f2",
      "cf913ca9201506bd1e84da974b6a3b604f76ac885de4202753c891f9460ecd3a",
      "3fac27dce5ab0f2ae844d2927db406d44253151e62cab4c50a7790f7bc273b33",
    ]),
    managedActionCandidateSha256: null,
  }),
]);

const matchesIdentityAndTopology = (node, contract) => (
  node?.id === ROUTER_ID
  && node?.type === "function"
  && node?.name === ROUTER_NAME
  && node?.outputs === contract.outputs
  && isDeepStrictEqual(node?.wires, contract.wires)
);

export function matchesManagedSubscriptionRouterTopology(node) {
  return MANAGED_SUBSCRIPTION_ROUTER_CONTRACTS.some((contract) => (
    matchesIdentityAndTopology(node, contract)
  ));
}

export function matchesManagedSubscriptionRouterContract(node, funcSha256) {
  return Boolean(resolveManagedSubscriptionRouterContract(node, funcSha256));
}

export function resolveManagedSubscriptionRouterContract(node, funcSha256) {
  return MANAGED_SUBSCRIPTION_ROUTER_CONTRACTS.find((contract) => (
    matchesIdentityAndTopology(node, contract)
    && contract.funcSha256.includes(funcSha256)
  )) || null;
}
