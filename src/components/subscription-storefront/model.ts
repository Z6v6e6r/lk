export type SubscriptionBenefitIcon =
  | 'game'
  | 'training'
  | 'group'
  | 'friends-time'
  | 'tournament';

export interface SubscriptionBillingProgress {
  readonly current: number;
  readonly total: number;
  readonly label: string;
}

export interface SubscriptionBillingOption {
  readonly id: string;
  readonly label: string;
  readonly priceMinor: number | null;
  readonly ctaDisabled?: boolean;
  readonly ctaLabel?: string;
  readonly statusMessage?: string;
  readonly benefitGroups?: readonly SubscriptionBenefitGroup[];
  readonly priceSuffix?: string;
  readonly progress?: SubscriptionBillingProgress;
}

export interface SubscriptionBenefit {
  readonly id: string;
  readonly label: string;
  readonly icon?: SubscriptionBenefitIcon;
  readonly badge?: string;
}

export interface SubscriptionBenefitGroup {
  readonly id: string;
  readonly title: string;
  readonly items: readonly SubscriptionBenefit[];
  /** `note` renders the group as the compact footer line instead of a list. */
  readonly kind?: 'list' | 'note';
}

export interface SubscriptionPlanView {
  readonly id: string;
  readonly label: string;
  /** `plain` renders the label as a headline instead of the badge artwork. */
  readonly labelKind?: 'badge' | 'plain';
  readonly tagTone?: string;
  readonly artUrl?: string;
  readonly featured?: boolean;
  readonly billingOptions: readonly SubscriptionBillingOption[];
  readonly initialBillingOptionId?: string;
  readonly ctaLabel?: string;
  /** When true, CTA is non-interactive (e.g. sold out). */
  readonly ctaDisabled?: boolean;
  readonly benefitGroups: readonly SubscriptionBenefitGroup[];
}

export interface SubscriptionOfferSectionView {
  readonly id: string;
  readonly title?: string;
  readonly description?: string;
  readonly plans: readonly SubscriptionPlanView[];
}

export interface SubscriptionStorefrontTheme {
  readonly accent?: string;
  readonly accentStrong?: string;
  readonly pageBackground?: string;
  readonly surface?: string;
  readonly text?: string;
}

export interface SubscriptionStorefrontView {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly markUrl?: string;
  readonly markAlt?: string;
  readonly sections: readonly SubscriptionOfferSectionView[];
  readonly theme?: SubscriptionStorefrontTheme;
}

export interface SubscriptionPlanSelection {
  readonly planId: string;
  readonly billingOptionId: string;
}
