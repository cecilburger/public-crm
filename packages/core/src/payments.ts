/**
 * The payment provider seam.
 *
 * Xendit and Midtrans differ in their wire format and in almost nothing else
 * that matters here: both take an amount and a reference and hand back a URL to
 * send someone to. Keeping that behind an interface means choosing between them
 * is one adapter, not a refactor — and it means collection can start manually,
 * by bank transfer, before either is wired.
 */

export interface PaymentRequest {
  /** Our reference, echoed back on the callback. */
  reference: string;
  amountIdr: number;
  description: string;
  payerEmail?: string | null;
  expiresAt?: Date;
  redirectUrl?: string;
}

export interface PaymentHandle {
  provider: string;
  /** The provider's own id for this payment, stored for reconciliation. */
  providerRef: string;
  /** Where to send the payer. Null when collection is manual. */
  url: string | null;
  instructions?: string;
  expiresAt?: Date | null;
}

export type PaymentStatus = 'pending' | 'paid' | 'expired' | 'failed';

export interface PaymentCallback {
  reference: string;
  providerRef: string;
  status: PaymentStatus;
  amountIdr: number;
  paidAt: Date | null;
}

export interface PaymentProvider {
  readonly name: string;
  createPayment(request: PaymentRequest): Promise<PaymentHandle>;
  /**
   * Verify a provider callback and normalise it. Returns null when the
   * signature does not check out — never throw here, because a provider that
   * gets a 500 will retry the same bad payload forever.
   */
  parseCallback(rawBody: Buffer, headers: Record<string, string | undefined>): PaymentCallback | null;
}

/**
 * Bank transfer. What the first ten customers will actually use, and what the
 * shortest launch path assumes: a spreadsheet, a bank account, and somebody
 * marking invoices paid.
 *
 * It is a real implementation, not a stub — it just has no URL to hand back.
 */
export class ManualTransferProvider implements PaymentProvider {
  readonly name = 'manual_transfer';

  constructor(private instructions: string) {}

  async createPayment(request: PaymentRequest): Promise<PaymentHandle> {
    return {
      provider: this.name,
      providerRef: request.reference,
      url: null,
      instructions: this.instructions,
      expiresAt: request.expiresAt ?? null,
    };
  }

  /** Nothing calls back. Payment is confirmed by a person reading a bank statement. */
  parseCallback(): PaymentCallback | null {
    return null;
  }
}
