import type { TrustCenterConfig } from "../../../domain/attestation.js";
import type {
  ActionType,
  AgentName,
  AutonomyMode,
  AuthorityBasis,
  IdentifierCategory,
  Jurisdiction,
  PaymentMode,
  PresetId,
  RiskLevel
} from "../../../domain/types.js";
import type { OneShotRelayBody } from "../../../domain/oneshot.js";
import type { MemoryStore } from "../../../storage/memoryStore.js";
import { HttpError } from "../../errors.js";

export interface ConsumerContext {
  store: MemoryStore;
  trustCenterPath: string;
  loadTrustCenterConfig: () => Promise<TrustCenterConfig>;
}

export interface CreateCaseBody {
  jurisdiction: Jurisdiction;
  riskLevel?: RiskLevel;
  authorityBasis: AuthorityBasis;
  retentionDays?: number;
  casePreferences?: {
    operatorEmailRelay?: boolean;
  };
}

export interface ProposeActionBody {
  caseId: string;
  actionType: ActionType;
  destination: string;
  purpose: string;
  identifiers: IdentifierCategory[];
  dataToDisclose: IdentifierCategory[];
  sourceVerified?: boolean;
  plaintextPreview?: string;
  expectedConfirmationStep?: string;
}

export interface CaseBody {
  caseId: string;
}

export interface SmartAccountBody {
  caseId: string;
  walletAddress: string;
  mode?: "demo" | "live";
  smartAccountAddress?: string;
  txHash?: string;
  callsId?: string;
  chainId?: number;
}

export interface PaymentBody {
  caseId: string;
  productId?: string;
  walletAddress?: string;
  smartAccountAddress?: string;
}

export interface VeniceBody {
  caseId: string;
  notes?: string;
  destination?: string;
  actionType?: ActionType;
}

export interface AgentDelegateBody {
  caseId: string;
}

export interface AgentMessageBody {
  caseId: string;
  fromAgent?: string;
  toAgent?: string;
  purpose: string;
  payload?: string;
}

export interface RelayerBody extends OneShotRelayBody {}

export interface CasePreferencesBody {
  operatorEmailRelay: boolean;
}

export interface CreditsPurchaseBody {
  caseId: string;
  walletAddress: string;
  paymentSessionId?: string;
  smartAccountAddress?: string;
  productId?: string;
}

export interface AgentRunBody {
  caseId: string;
  walletAddress?: string;
  smartAccountAddress?: string;
}

export interface CaseAgentRunBody {
  highAutonomy?: boolean;
}

export function parseAgentName(value: string): AgentName {
  const allowed: AgentName[] = [
    "OblivionRoot",
    "ScoutAgent",
    "DraftAgent",
    "VerifierAgent",
    "PaymentAgent",
    "SchedulerAgent"
  ];
  if (!allowed.includes(value as AgentName)) throw new HttpError(422, "unsupported-agent");
  return value as AgentName;
}