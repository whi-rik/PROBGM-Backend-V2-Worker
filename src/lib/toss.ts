import { HTTPException } from "hono/http-exception";
import type { Bindings } from "../env";

const TOSS_API_BASE_URL = "https://api.tosspayments.com";

interface TossErrorShape {
  code?: string;
  message?: string;
}

function buildBasicAuth(secretKey: string): string {
  return `Basic ${btoa(`${secretKey}:`)}`;
}

async function tossRequest<T>(
  secretKey: string,
  path: string,
  init: RequestInit,
): Promise<T> {
  if (!secretKey) {
    throw new HTTPException(500, { message: "Toss Payments secret key is not configured" });
  }

  const response = await fetch(`${TOSS_API_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: buildBasicAuth(secretKey),
      "Content-Type": "application/json; charset=utf-8",
      "Idempotency-Key": crypto.randomUUID(),
      ...(init.headers || {}),
    },
  });

  const text = await response.text();
  let payload: TossErrorShape | T | null = null;
  try {
    payload = text ? (JSON.parse(text) as TossErrorShape | T) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const errorPayload = payload as TossErrorShape | null;
    throw new HTTPException(response.status as 400 | 401 | 402 | 403 | 404 | 429 | 500 | 502 | 503 | 504, {
      message:
        errorPayload?.message ||
        `Toss Payments request failed with status ${response.status}`,
    });
  }

  return payload as T;
}

export interface TossBillingKeyResponse {
  billingKey: string;
  customerKey: string;
  authenticatedAt?: string;
  card?: {
    company?: string;
    number?: string;
    cardType?: string;
  };
}

export interface TossPaymentResponse {
  paymentKey: string;
  orderId: string;
  orderName: string;
  method?: string;
  status?: string;
  totalAmount: number;
  balanceAmount?: number;
  currency?: string;
  requestedAt?: string;
  approvedAt?: string;
  lastTransactionKey?: string;
  receipt?: { url?: string };
  card?: Record<string, unknown>;
  checkout?: { url?: string };
  failure?: {
    code?: string;
    message?: string;
  };
  cancels?: Array<Record<string, unknown>>;
}

export interface TossCancelPaymentRequest {
  cancelReason: string;
  cancelAmount?: number;
  taxFreeAmount?: number;
  taxExemptionAmount?: number;
  refundReceiveAccount?: Record<string, unknown>;
  refundVirtualAccount?: boolean;
}

export async function issueBillingKeyWithToss(
  env: Bindings,
  body: {
    authKey: string;
    customerKey: string;
    customerName?: string;
    customerEmail?: string;
  },
) {
  const secretKey = env.TOSS_PAYMENTS_BILLING_SECRET_KEY || env.TOSS_PAYMENTS_SECRET_KEY || "";
  return tossRequest<TossBillingKeyResponse>(secretKey, "/v1/billing/authorizations/issue", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function executeBillingWithToss(
  env: Bindings,
  billingKey: string,
  body: {
    customerKey: string;
    amount: number;
    orderId: string;
    orderName: string;
    customerEmail?: string | null;
    customerName?: string | null;
  },
) {
  const secretKey = env.TOSS_PAYMENTS_BILLING_SECRET_KEY || env.TOSS_PAYMENTS_SECRET_KEY || "";
  return tossRequest<TossPaymentResponse>(secretKey, `/v1/billing/${billingKey}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function confirmPaymentWithToss(
  env: Bindings,
  body: {
    paymentKey: string;
    orderId: string;
    amount: number;
  },
) {
  const secretKey = env.TOSS_PAYMENTS_SECRET_KEY || "";
  return tossRequest<TossPaymentResponse>(secretKey, "/v1/payments/confirm", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function cancelPaymentWithToss(
  env: Bindings,
  paymentKey: string,
  body: TossCancelPaymentRequest,
) {
  const secretKey = env.TOSS_PAYMENTS_SECRET_KEY || "";
  return tossRequest<TossPaymentResponse>(secretKey, `/v1/payments/${paymentKey}/cancel`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
