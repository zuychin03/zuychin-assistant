import { getSessionByCode, type CouncilSession } from "./store";
import {
    acknowledgeDelivery, claimHostLease, failDelivery, markDeliveryInFlight,
    prepareDelivery, releaseHostLease, renewHostLease, startAgentExecution,
    stopAgentExecution,
} from "./host-service";
import { issueHostSeatKey } from "./seat-keys";
import type { CouncilHostPrincipal, CouncilSeatPrincipal } from "./v3";

export interface CouncilHostContext {
    session: CouncilSession;
    principal: CouncilHostPrincipal;
}

export async function resolveCouncil(code: string): Promise<CouncilSession | null> {
    return getSessionByCode(code);
}

export function assertSeatPrincipal(
    principal: CouncilSeatPrincipal,
    session: CouncilSession,
    claimedName?: string,
): void {
    if (principal.sessionId !== session.id) throw new Error("seat belongs to another council");
    if (claimedName && principal.seatName !== claimedName) throw new Error("seat identity mismatch");
}

export function assertV3Host(session: CouncilSession): void {
    if (session.protocolVersion !== 3) throw new Error("operation requires a Council V3 session");
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
