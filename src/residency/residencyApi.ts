import { createResidencyPassClient, type ResidencyPassClient } from "./residencyPassClient.ts";
import { residencyGatewayTransport } from "./residencyPassTransport.ts";

/** Browser client for the LK residency gateway (privileged tokens stay server-side). */
export const residencyPassClient: ResidencyPassClient = createResidencyPassClient(residencyGatewayTransport);
