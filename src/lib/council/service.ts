import { getSessionByCode, type CouncilSession } from "./store";
import {
    acknowledgeDelivery, claimHostLease, failDelivery, markDeliveryInFlight,
    prepareDelivery, releaseHostLease, renewHostLease, startAgentExecution,
    stopAgentExecution,
} from "./host-service";
import { issueHostSeatKey } from "./seat-keys";
import type { CouncilHostPrincipal } from "./v3";

export interface CouncilHostContext {
    session: CouncilSession;
    principal: CouncilHostPrincipal;
}

export async function resolveCouncil(code: string): Promise<CouncilSession | null> {
    return getSessionByCode(code);
}

export const councilHostService = {
    claimLease: claimHostLease,
    renewLease: renewHostLease,
    releaseLease: releaseHostLease,
    issueSeat: issueHostSeatKey,
    prepareDelivery,
    markDeliveryInFlight,
    failDelivery,
    acknowledgeDelivery,
    startExecution: startAgentExecution,
    stopExecution: stopAgentExecution,
};
