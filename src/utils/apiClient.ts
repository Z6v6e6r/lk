import { getCookie } from "./cookies";
import { TENANT_KEY, API_BASE, SERV2, SERV2_FALLBACK, SUCCESS_URL, FAIL_URL } from "../consts/api_config";

export interface UserProfileType {
  id: string;
  email: string | null;
  firstName: string;
  lastName: string;
  middleName: string;
  sex: string;
  photo: string | null;
  phone: string;
  birthDate: string | null;
  deposit: number;
  trialUsed: boolean;
  withCard: boolean;
  loyaltyCard: string;
  clientCategory: { id: number; name: string };
  customFields: CustomField[];
}

export interface CustomFieldOption {
  id: string;
  name: string;
  default?: boolean;
}

export interface CustomFieldAttributes {
  placeholder?: string;
  options?: CustomFieldOption[];
  default?: string;
}

export interface CustomFieldSettings {
  visibleInWidget?: boolean;
  alwaysAsk?: boolean;
}

export interface CustomField {
  value: string[];
  id: string;
  name: string;
  description?: string;
  required?: boolean;
  resource?: string;
  type?: string;
  attributes?: CustomFieldAttributes;
  settings?: CustomFieldSettings;
  enabled?: boolean;
}

export interface CustomFieldValue {
  id: string;
  value: string[];
}

export interface SubscriptionAvailableStudios {
  id: string;
  name: string;
}

export interface SubscriptionAvailableTypes {
  id: string;
  name: string;
}

export interface SubscriptionAvailableDirections {
  id: string;
  name: string;
}

export interface Subscription {
  subscriptionId: string;
  name: string | null;
  cost: number;
  type: string;
  status: string;
  purchaseDate: string;
  autoActivationDate: string | null;
  activationDate: string | null;
  expirationDate: string | null;
  holdUntil: string | null;
  validityDays: number;
  totalFreezeDays: number;
  freezingDays: number;
  freezeUsed: boolean;
  hasStudioLimitation: boolean;
  availableStudios: SubscriptionAvailableStudios[];
  hasTypeLimitation: boolean;
  availableTypes: SubscriptionAvailableTypes[];
  hasDirectionLimitation: boolean;
  availableDirections: SubscriptionAvailableDirections[];
  hasDayLimitation: boolean;
  hasTimeRangeLimitation: boolean;
  variant: string;
  visitsTotal: number;
  visitsLeft: number;
  timeLimitation: string;
  minutes: number;
  availableMinutes: number;
  duration: string;
  availableDays: string;
}

export interface AdvertisementType {
  imgUrl: string;
  href: string;
}
export interface apiSubscription {
  id: string;
  productType: string;
  name: string;
  cost: number;
  discountPrice: number;
  bonusPoints: number;
  showToUser: boolean;
  type: string;
  activationDays: number;
  validityDays: number;
  freezingDays: number;
  hasStudioLimitation: boolean;
  availableStudios: SubscriptionAvailableStudios[];
  hasTypeLimitation: boolean;
  availableTypes: SubscriptionAvailableTypes[];
  hasDirectionLimitation: boolean;
  availableDirections: SubscriptionAvailableDirections[];
  hasDayLimitation: boolean;
  availableDaysOfWeek: [];
  hasTimeRangeLimitation: boolean;
  availableTimeRanges: [];
  variant: string;
  visits: number;
  timeLimitation: string;
  minutes: number;
  duration: string;
  photos: [];
  nameInReceipt: string | null;
  imgUrl: string;
}

export interface SubscriptionResponse {
  content: Subscription[];
  pageable: {
    pageNumber: number;
    pageSize: number;
    sort: {
      empty: boolean;
      sorted: boolean;
      unsorted: boolean;
    };
    offset: number;
    paged: boolean;
  };
  last: boolean;
  totalElements: number;
  totalPages: number;
  first: boolean;
  size: number;
  number: number;
  numberOfElements: number;
  empty: boolean;
}

export interface Studio {
  id: string;
  name: string;
  country: string;
  city: string;
  address: string;
}

export interface Room {
  id: string;
  name: string;
}

export interface Grade {
  id: string;
  name: string;
}

export interface Trainer {
  id: string;
  firstName: string;
  lastName: string;
  photo?: string;
  grade?: Grade;
  bio?: string;
}

export interface Direction {
  id: number;
  name: string;
  description?: string | null;
  photo?: string | null;
  whatToTake?: string | null;
  photoWeb?: string | null;
  duration?: string | null;
}

export interface ExerciseType {
  id: number;
  name: string;
  color: string;
  format: string;
}

export interface Exercise {
  id: string;
  direction: Direction;
  type: ExerciseType;
  timeFrom: string;
  timeTo: string;
  clientsCount: number;
  maxClientsCount: number;
  girlsOnly: boolean;
  studio: Studio;
  room: Room;
  trainers: Trainer[];
  cancellationDeadline?: string | null;
}

export interface ExerciseBookingClient {
  id: string;
  firstName?: string;
  lastName?: string;
  middleName?: string;
  photo?: string;
  phone?: string;
}

export interface ExerciseBooking {
  id: string;
  spot?: number;
  isCancelled?: boolean;
  client?: ExerciseBookingClient;
  rating?: string;
  ratingSource?: "level" | "phone";
}

export interface AmericanoTournamentPayload {
  tournamentId: string;
  tenantKey: string;
  createdAt: string;
  organizer: {
    id: string | null;
    phone: string | null;
    tenantKey: string;
  };
  tournamentType: "americano";
  targetScore: number;
  courts: string[];
  participants: Array<{
    id: string | null;
    phone: string | null;
    rating: string | null;
    photo: string | null;
    name: string;
  }>;
  rounds?: Array<{
    id: string;
    index: number;
    matches: Array<{
      id: string;
      court: string;
      pair1: string[];
      pair2: string[];
      score1: number | null;
      score2: number | null;
    }>;
  }>;
}

export interface AmericanoResultsPayload {
  tournamentId: string;
  results: Array<{
    roundId: string;
    matchId: string;
    score1: number;
    score2: number;
    pair1?: string[];
    pair2?: string[];
  }>;
  params?: Record<string, unknown>;
}

export interface AmericanoResultsResponse {
  totals?: Record<
    string,
    {
      ratingBefore: number;
      ratingAfter: number;
      deltaTotal: number;
      wins: number;
      losses: number;
      draws: number;
      pointsFor: number;
      pointsAgainst: number;
    }
  >;
  rounds?: unknown[];
  playerLogs?: Record<
    string,
    Array<{
      roundId?: string;
      matchId?: string;
      scoreFor?: number;
      scoreAgainst?: number;
      delta?: number;
      ratingBefore?: number;
      ratingAfter?: number;
      expected?: number;
      actual?: number;
    }>
  >;
}

export interface Booking {
  id: string;
  spot: number;
  paymentType: string;
  isCancelled: boolean;
  cancellationReason?: string | null;
  visitConfirmed: boolean;
  exercise?: Exercise;
  reviewRate?: number | null;
  reviewComment?: string | null;
  clientSubscriptionId?: string | null;
  clientOneTimeId?: string | null;
  cost: number;
  transactionStatus?: {
    transactionId: string;
    transactionStatus: string;
    cardPaymentStatus?: {
      paymentId: string;
      paymentUrl: string;
      status: string;
      originalStatus: string;
      errorCode?: string | null;
    } | null;
  } | null;
  cancellationDeadline: string;
}

export interface BookingsResponse {
  content: Booking[];
  pageable: {
    pageNumber: number;
    pageSize: number;
    sort: {
      empty: boolean;
      sorted: boolean;
      unsorted: boolean;
    };
    offset: number;
    paged: boolean;
  };
  totalPages: number;
  totalElements: number;
  last: boolean;
  first: boolean;
  numberOfElements: number;
  size: number;
  number: number;
  empty: boolean;
}

export interface UpdateProfileData {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  middleName: string | null;
  photo: string | null;
  sex: string | null;
  customFields?: CustomFieldValue[];
}

export interface SubscriptionName {
  sertName: string;
}

export interface PaymentUrl {
  toPay: number;
  paymentUrl: string;
}

export type ApiStatus = number | null;

export interface ApiError {
  status: ApiStatus;
  message: string;
  raw?: unknown;
}

export interface ApiResult<T> {
  data: T | null;
  error: ApiError | null;
  status: ApiStatus;
}

interface RequestOptions extends RequestInit {
  auth?: boolean;
  retries?: number;
  baseUrl?: string;
  signal?: AbortSignal
}

async function rawRequest<T>(
  url: string,
  options: RequestOptions = {},
): Promise<ApiResult<T>> {
  const { auth = false, baseUrl = API_BASE, ...fetchOptions } = options;

  const headers = new Headers(fetchOptions.headers ?? {});

  if (auth) {
    const token = getCookie(`${TENANT_KEY}AuthToken`);
    if (!token) {
      return {
        data: null,
        error: { status: 401, message: "Не авторизован" },
        status: 401,
      };
    }
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }

  if (
    fetchOptions.body &&
    !headers.has("Content-Type") &&
    !(fetchOptions.body instanceof FormData)
  ) {
    headers.set("Content-Type", "application/json");
  }

  const fullUrl = url.startsWith("http") ? url : `${baseUrl}${url}`;

  let response: Response;

  try {
    response = await fetch(fullUrl, { ...fetchOptions, headers });
  } catch (err) {
    return {
      data: null,
      error: { status: null, message: "Ошибка сети", raw: err },
      status: null,
    };
  }

  const status = response.status;

  let payload: any = null;
  const contentType = response.headers.get("Content-Type") || "";
  if (contentType.includes("application/json")) {
    payload = await response.json().catch(() => null);
  } else {
    payload = await response.text().catch(() => null);
  }

  if (!response.ok) {
    const message =
      (payload && (payload.message || payload.error_description)) ||
      `Ошибка запроса (${status})`;

    return {
      data: null,
      error: { status, message, raw: payload },
      status,
    };
  }

  return {
    data: (payload as T) ?? null,
    error: null,
    status,
  };
}

export async function request<T>(
  url: string,
  options: RequestOptions = {},
): Promise<ApiResult<T>> {
  const { retries = 0 } = options;
  if (retries > 0) {
    return withRetry(() => rawRequest<T>(url, options), { retries });
  }
  return rawRequest<T>(url, options);
}

export function getServ2Origin() {
  try {
    return new URL(SERV2).origin;
  } catch {
    return SERV2;
  }
}

function shouldFallback(result: ApiResult<unknown>) {
  return result.status == null || result.status >= 500;
}

async function requestWithFallback<T>(
  primaryUrl: string,
  fallbackUrl: string | undefined,
  options: RequestOptions = {},
): Promise<ApiResult<T>> {
  const primary = await request<T>(primaryUrl, options);
  if (!fallbackUrl || fallbackUrl === primaryUrl) return primary;
  if (!shouldFallback(primary)) return primary;
  const fallback = await request<T>(fallbackUrl, options);
  return fallback.data ? fallback : primary;
}

async function withRetry<T>(
  fn: () => Promise<ApiResult<T>>,
  {
    retries = 2,
    baseDelayMs = 300,
  }: { retries?: number; baseDelayMs?: number } = {},
): Promise<ApiResult<T>> {
  let attempt = 0;
  while (true) {
    try {
      const res = await fn();
      if (res.status !== 200 && res.status !== 204 && res.status !== 304) {
        attempt++;
        if (attempt > retries) {
          return res;
        }
        const delay = baseDelayMs * 2 ** (attempt - 1);
        await new Promise((res) => setTimeout(res, delay));
      } else {
        return res;
      }
    } catch (err) {
      attempt++;
      if (attempt > retries) {
        return {
          data: null,
          error: { status: null, message: "Ошибка сети", raw: err },
          status: null,
        };
      }
      const delay = baseDelayMs * 2 ** (attempt - 1);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

export async function apiFetchProfile() {
  return request<UserProfileType>(`/end-user/api/v1/${TENANT_KEY}/profile`, {
    method: "GET",
    auth: true,
    retries: 1,
  });
}

export async function apiUpdateProfile(data: UpdateProfileData) {
  return request<UserProfileType>(`/end-user/api/v1/${TENANT_KEY}/profile`, {
    method: "PATCH",
    auth: true,
    retries: 1,
    body: JSON.stringify(data),
  });
}

export interface OnboardingLevelPayload {
  clientId: string;
  phone?: string | null;
  levelLetter: string;
  levelNumeric: string | number;
}

export async function apiSaveOnboardingLevel(payload: OnboardingLevelPayload) {
  const baseUrl = getServ2Origin() || "";
  return request<{ ok: boolean }>(`/lk/onboarding/level`, {
    method: "POST",
    baseUrl,
    retries: 1,
    body: JSON.stringify(payload),
  });
}

export async function apiUpdateCustomFields(profile: UserProfileType, customFields: CustomField[]) {
  const customFieldValues: CustomFieldValue[] = customFields.map((field) => ({
    id: field.id,
    value: field.value ?? [],
  }));
  return apiUpdateProfile({
    email: profile.email ?? null,
    firstName: profile.firstName ?? null,
    lastName: profile.lastName ?? null,
    middleName: profile.middleName ?? null,
    photo: profile.photo ?? null,
    sex: profile.sex ?? "U",
    customFields: customFieldValues,
  });
}

export async function apiUploadProfilePhoto(file: File) {
  const formData = new FormData();
  formData.append("file", file);
  return request<string>(
    `${API_BASE}/end-user/api/v1/${TENANT_KEY}/profile/photo`,
    {
      method: "PUT",
      auth: true,
      retries: 1,
      body: formData,
    },
  );
}

export async function apiFetchBookings(includeCanceled: boolean) {
  const url = includeCanceled
    ? `/end-user/api/v2/${TENANT_KEY}/bookings/history?includeCanceled=true&size=1000`
    : `/end-user/api/v2/${TENANT_KEY}/bookings?size=1000`;

  return request<BookingsResponse>(url, {
    method: "GET",
    auth: true,
    retries: 1,
  });
}

export async function apiCancelBooking(bookingId: string) {
  return request<BookingsResponse>(
    `${API_BASE}/end-user/api/v1/${TENANT_KEY}/bookings/${bookingId}`,
    {
      method: "DELETE",
      auth: true,
      retries: 1,
      body: JSON.stringify({}),
    },
  );
}

export async function apiFetchSubscriptions() {
  return request<SubscriptionResponse>(
    `${API_BASE}/end-user/api/v1/${TENANT_KEY}/subscriptions`,
    {
      method: "GET",
      auth: true,
      retries: 1,
    },
  );
}

export async function apiFetchExercisesByDate(date: string) {
  return request<Exercise[]>(
    `${API_BASE}/end-user/api/v1/${TENANT_KEY}/exercises?date=${date}`,
    {
      method: "GET",
      auth: true,
      retries: 1,
    },
  );
}

export async function apiFetchExerciseBookings(exerciseId: string) {
  return request<ExerciseBooking[]>(
    `${API_BASE}/end-user/api/v1/${TENANT_KEY}/exercises/${exerciseId}/bookings`,
    {
      method: "GET",
      auth: true,
      retries: 1,
    },
  );
}

export async function apiFetchTournamentParticipants(exerciseId: string) {
  const base = getServ2Origin();
  return request<ExerciseBooking[]>(
    `${base}/lk/tournaments/participants?exerciseId=${exerciseId}`,
    {
      method: "GET",
      retries: 1,
    },
  );
}

export async function apiCreateAmericanoTournament(payload: AmericanoTournamentPayload) {
  const base = getServ2Origin();
  return request<{ ok?: boolean }>(`${base}/lk/tournaments/americano`, {
    method: "POST",
    retries: 1,
    body: JSON.stringify(payload),
  });
}

export async function apiUpdateAmericanoResults(payload: AmericanoResultsPayload) {
  const base = getServ2Origin();
  return request<AmericanoResultsResponse>(`${base}/lk/tournaments/americano/results`, {
    method: "POST",
    retries: 1,
    body: JSON.stringify(payload),
  });
}

export async function apiFetchStudios() {
  return request<Studio[]>(
    `${API_BASE}/end-user/api/v1/${TENANT_KEY}/studios`,
    {
      method: "GET",
      auth: true,
      retries: 1,
    },
  );
}

export async function apiFetchSubscriptioName(subId: string, phone: string) {
  const primary = `${SERV2}?type=get_sub_name&phone=${phone}&subId=${subId}`;
  const fallback = SERV2_FALLBACK
    ? `${SERV2_FALLBACK}?type=get_sub_name&phone=${phone}&subId=${subId}`
    : undefined;
  return requestWithFallback<SubscriptionName>(primary, fallback, {
    method: "GET",
    retries: 1,
  });
}

export async function apiBuySubscroption(
  subscroptionId: string,
  phone: string,
) {
  return request<PaymentUrl>(
    `${API_BASE}/end-user/api/v1/${TENANT_KEY}/transactions`,
    {
      method: "POST",
      auth: true,
      retries: 1,
      body: JSON.stringify({
        clientPhone: phone,
        failUrl: FAIL_URL,
        paymentMethod: "WIDGET",
        products: [
          {
            id: subscroptionId,
            type: "SUBSCRIPTION",
            count: 1,
          },
        ],
        count: 1,
        id: subscroptionId,
        type: "SUBSCRIPTION",
        successUrl: SUCCESS_URL,
      }),
    },
  );
}

export async function apiGetSubscriptionsForSale() {
  const primary = `${SERV2}?type=sub_for_sale`;
  const fallback = SERV2_FALLBACK ? `${SERV2_FALLBACK}?type=sub_for_sale` : undefined;
  return requestWithFallback<apiSubscription[]>(primary, fallback, {
    method: "GET",
    retries: 1,
  });
}

export async function apiGetAdvertisement() {
  const primary = `${SERV2}?type=advertisement`;
  const fallback = SERV2_FALLBACK ? `${SERV2_FALLBACK}?type=advertisement` : undefined;
  return requestWithFallback<AdvertisementType>(primary, fallback, {
    method: "GET",
    retries: 1,
  });
}
