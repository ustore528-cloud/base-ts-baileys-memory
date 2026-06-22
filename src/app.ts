import 'dotenv/config'
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB as Database } from '@builderbot/bot'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'

const PORT = process.env.PORT ?? 3008
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY
const GOOGLE_REGION_CODE = process.env.GOOGLE_REGION_CODE ?? 'PS'

const NEXT_BUTTON = 'التالي ➡️'
const PREV_BUTTON = 'السابق ⬅️'
const CONTINUE_BUTTON = 'متابعة ➡️'
const CONFIRM_BUTTON = 'تأكيد ✅'
const CANCEL_BUTTON = 'إلغاء ❌'

const BUTTON_LABEL_MAX = 20

const cities = [
    'القدس',
    'رام الله',
    'بيت لحم',
    'الخليل',
    'نابلس',
    'جنين',
    'أريحا',
]

const cityCenters: Record<string, { lat: number; lng: number }> = {
    'القدس': { lat: 31.7683, lng: 35.2137 },
    'رام الله': { lat: 31.9038, lng: 35.2034 },
    'بيت لحم': { lat: 31.7054, lng: 35.2024 },
    'الخليل': { lat: 31.5326, lng: 35.0998 },
    'نابلس': { lat: 32.2211, lng: 35.2544 },
    'جنين': { lat: 32.4594, lng: 35.3009 },
    'أريحا': { lat: 31.8560, lng: 35.4599 },
}

type BotStep =
    | 'ASK_NAME'
    | 'ASK_PHONE'
    | 'PICKUP_CITY'
    | 'PICKUP_AREA'
    | 'DROPOFF_CITY'
    | 'DROPOFF_AREA'
    | 'ASK_DETAILS'
    | 'CONFIRM_ORDER'

type LocationSource = 'GOOGLE' | 'NEEDS_REVIEW'

type SelectionKind = 'pickup' | 'dropoff'

type ResolvedLocation = {
    label: string
    placeId: string | null
    lat: number | null
    lng: number | null
    source: LocationSource
    originalText: string
    city: string
}

type AddressSuggestion = {
    label: string
    buttonLabel: string
    placeId: string
    lat: number
    lng: number
    source: 'GOOGLE'
}

type RouteResult = {
    distanceMeters: number | null
    durationText: string | null
    source: 'GOOGLE_ROUTES' | 'NEEDS_REVIEW'
}

type PricingConfig = {
    baseFee: number
    pricePerKm: number
    minimumFee: number
    maximumFee: number
}

type BotButton = { body: string }

type PageChoice<T> = {
    item: T
    buttonLabel: string
    number: number
}

type PaginatedPage<T> = {
    body: string
    buttons: BotButton[]
    items: T[]
    choices: PageChoice<T>[]
}

type FlowDynamicFn = (
    messages: Array<string | { body?: string; buttons?: BotButton[] }>,
    options?: { continue?: boolean }
) => Promise<void>

type BotState = {
    get: (key: string) => unknown
    update: (data: Record<string, unknown>) => Promise<void>
    clear: () => Promise<void>
}

const normalizeDigits = (text: string) => {
    return text
        .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
        .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
        .trim()
}

const normalizeText = (text: string) => {
    return normalizeDigits(text)
        .toLowerCase()
        .replace(/[أإآ]/g, 'ا')
        .replace(/ة/g, 'ه')
        .replace(/ى/g, 'ي')
        .replace(/ؤ/g, 'و')
        .replace(/ئ/g, 'ي')
        .replace(/[^\u0600-\u06FFa-zA-Z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

const cleanPhone = (phone: string) => {
    return normalizeDigits(phone)
        .replace(/\s/g, '')
        .replace(/-/g, '')
}

const isCancel = (text: string) => {
    const normalized = normalizeText(text)
    const cancelWords = ['الغاء', 'الغى', 'الغي', 'cancel', CANCEL_BUTTON].map(normalizeText)

    if (cancelWords.includes(normalized)) return true
    if (normalized.startsWith('الغ') && normalized.length <= 6) return true
    if (normalized.startsWith('canc')) return true
    return false
}

const isConfirm = (text: string) => {
    const normalized = normalizeText(text)
    return (
        normalized === 'تاكيد' ||
        normalized.startsWith('تاكيد') ||
        normalized === normalizeText(CONFIRM_BUTTON)
    )
}

const isValidPhone = (phone: string) => {
    const cleaned = cleanPhone(phone)
    return /^05\d{8}$/.test(cleaned) || /^9725\d{8}$/.test(cleaned)
}

const isStartOrder = (text: string) => {
    const normalized = normalizeText(text)

    const exactStartWords = [
        'طلب',
        'طلبية',
        'طلبيه',
        'طلب جديد',
        'ابدا',
        'ابدأ',
        'ابدء',
        'اطلب',
        'بدي طلب',
        'بدي شوفير',
        'بدي شليح',
        'اريد طلب',
        'أريد طلب',
        'اعمل طلب',
        'ابدأ طلب',
        'ابدا طلب',
        'بدي اوصل',
        'بدي توصيل',
        'في حد فاضي',
        'في حد فاضى',
        'في حد يجيب طلبية',
        'في حد يجيب طلبيه',
    ].map(normalizeText)

    if (exactStartWords.includes(normalized)) return true

    const containsPhrases = [
        'بدي شوفير',
        'بدي شليح',
        'في حد فاضي',
        'في حد يجيب طلب',
        'بدي طلب',
        'اريد طلب',
        'اعمل طلب',
        'بدي اوصل',
        'بدي توصيل',
    ].map(normalizeText)

    if (containsPhrases.some((phrase) => normalized.includes(phrase))) return true
    if (/^ط+[لب]+[هي]*$/.test(normalized)) return true

    return false
}

const isSameCommand = (text: string, command: string) => {
    const normalized = normalizeText(text)
    const normalizedCommand = normalizeText(command)
    return normalized === normalizedCommand || text.trim() === command
}

const isNavigationCommand = (text: string) => {
    return (
        isSameCommand(text, NEXT_BUTTON) ||
        isSameCommand(text, PREV_BUTTON) ||
        isSameCommand(text, CONTINUE_BUTTON)
    )
}

const parseSelectionNumber = (text: string) => {
    const digits = normalizeDigits(text.trim()).replace(/[^\d]/g, '')
    if (!digits) return null

    const value = Number(digits)
    return Number.isInteger(value) && value >= 1 ? value : null
}

const isGreetingOrInquiry = (text: string) => {
    const normalized = normalizeText(text)

    const phrases = [
        'مرحبا',
        'مرحبه',
        'اهلا',
        'اهلين',
        'هلا',
        'السلام عليكم',
        'سلام عليكم',
        'سلام',
        'صباح الخير',
        'مسا الخير',
        'مساء الخير',
        'يعطيك العافيه',
        'يعطيكم العافيه',
        'يعطيك العافية',
        'الله يعطيك العافيه',
        'كيفك',
        'كيف الحال',
        'لو سمحت',
        'ممكن',
        'عندي سؤال',
        'سؤال',
        'استفسار',
        'بدي استفسر',
        'كم السعر',
        'قديش التوصيل',
        'كم تكلفة التوصيل',
        'وين بتوصلوا',
        'بتوصلوا',
        'في توصيل',
        'شو المناطق',
        'شو المدن',
        'مساعدة',
        'ساعدني',
    ].map(normalizeText)

    return phrases.some((phrase) => normalized.includes(phrase))
}

const buildWelcomeMessage = () => {
    return [
        'أهلًا وسهلًا في بوت التوصيل 👋',
        '',
        'أقدر أساعدك بإنشاء طلب توصيل من مدينة/منطقة الاستلام إلى مدينة/منطقة التسليم.',
        '',
        'لبدء طلب جديد اكتب:',
        'طلب',
        '',
        'أو اكتب سؤالك وسنحاول مساعدتك.',
    ].join('\n')
}

const createOrderNumber = () => {
    return Math.floor(100000 + Math.random() * 900000)
}

const toButtonLabel = (text: string) => {
    const trimmed = text.trim()
    if (trimmed.length <= BUTTON_LABEL_MAX) return trimmed
    return `${trimmed.slice(0, BUTTON_LABEL_MAX - 1)}…`
}

const buildItemPages = <T>(items: T[], getLabel: (item: T) => string): PaginatedPage<T>[] => {
    const pages: PaginatedPage<T>[] = []
    let index = 0
    let pageIndex = 0

    while (index < items.length) {
        const remaining = items.length - index
        const isFirst = pageIndex === 0
        const buttons: BotButton[] = []
        const pageItems: T[] = []
        const choices: PageChoice<T>[] = []
        let choiceNumber = 1

        if (isFirst) {
            const count = remaining > 2 ? 2 : remaining

            for (let i = 0; i < count; i += 1) {
                const item = items[index]
                const buttonLabel = getLabel(item)
                pageItems.push(item)
                choices.push({ item, buttonLabel, number: choiceNumber })
                buttons.push({ body: buttonLabel })
                choiceNumber += 1
                index += 1
            }

            if (index < items.length) {
                buttons.push({ body: NEXT_BUTTON })
            }
        } else if (remaining <= 2) {
            while (index < items.length) {
                const item = items[index]
                const buttonLabel = getLabel(item)
                pageItems.push(item)
                choices.push({ item, buttonLabel, number: choiceNumber })
                buttons.push({ body: buttonLabel })
                choiceNumber += 1
                index += 1
            }

            buttons.push({ body: PREV_BUTTON })
        } else {
            const item = items[index]
            const buttonLabel = getLabel(item)
            pageItems.push(item)
            choices.push({ item, buttonLabel, number: choiceNumber })
            buttons.push({ body: buttonLabel })
            index += 1
            buttons.push({ body: PREV_BUTTON })
            buttons.push({ body: NEXT_BUTTON })
        }

        pages.push({
            body: '',
            buttons,
            items: pageItems,
            choices,
        })

        pageIndex += 1
    }

    return pages
}

const getCityPages = () => buildItemPages(cities, (city) => city)

const getAreaPages = (areas: AddressSuggestion[]) => {
    return buildItemPages(areas, (area) => area.buttonLabel)
}

const buildNumberedPageBody = <T>(
    title: string,
    page: PaginatedPage<T>,
    pageIndex: number,
    totalPages: number
) => {
    const lines = [title]

    if (totalPages > 1) {
        lines.push(`صفحة ${pageIndex + 1} من ${totalPages}`)
    }

    for (const choice of page.choices) {
        lines.push(`${choice.number}. ${choice.buttonLabel}`)
    }

    const navButtons = page.buttons.filter((button) => isNavigationCommand(button.body))

    if (navButtons.length) {
        lines.push('')
        for (const button of navButtons) {
            lines.push(`• ${button.body}`)
        }
    }

    lines.push('', 'اختر رقمًا أو اكتب اسم الخيار.')
    return lines.join('\n')
}

const buildCityPage = (page: number, kind: SelectionKind): PaginatedPage<string> => {
    const pages = getCityPages()
    const safePage = Math.max(0, Math.min(page, pages.length - 1))
    const current = pages[safePage] ?? pages[0]
    const title = kind === 'pickup' ? 'اختر مدينة الاستلام:' : 'اختر مدينة التسليم:'

    return {
        ...current,
        body: buildNumberedPageBody(title, current, safePage, pages.length),
    }
}

const buildAreaPage = (
    areas: AddressSuggestion[],
    page: number,
    city: string,
    kind: SelectionKind
): PaginatedPage<AddressSuggestion> => {
    const pages = getAreaPages(areas)
    const safePage = Math.max(0, Math.min(page, pages.length - 1))
    const current = pages[safePage] ?? pages[0]
    const title =
        kind === 'pickup'
            ? `اختر منطقة الاستلام في ${city}:`
            : `اختر منطقة التسليم في ${city}:`

    return {
        ...current,
        body: buildNumberedPageBody(title, current, safePage, pages.length),
    }
}

const sendPagedMessage = async (
    flowDynamic: FlowDynamicFn,
    page: Pick<PaginatedPage<unknown>, 'body' | 'buttons'>
) => {
    console.log('[WHATSAPP_BUTTONS] sendPagedMessage', {
        body: page.body,
        buttons: page.buttons,
    })

    const fallbackText = [
        page.body,
        '',
        ...page.buttons.map((button) => `• ${button.body}`),
    ].join('\n')

    try {
        await flowDynamic(
            [
                {
                    body: page.body,
                    buttons: page.buttons,
                },
            ],
            { continue: false }
        )
    } catch (error) {
        console.error('[WHATSAPP_BUTTONS_ERROR]', error)
        await flowDynamic([{ body: fallbackText }], { continue: false })
    }
}

const sendText = async (flowDynamic: FlowDynamicFn, body: string) => {
    await flowDynamic([{ body }], { continue: false })
}

const getDefaultPricingConfig = (): PricingConfig => ({
    baseFee: Number(process.env.DELIVERY_BASE_FEE ?? 10),
    pricePerKm: Number(process.env.DELIVERY_PRICE_PER_KM ?? 3),
    minimumFee: Number(process.env.DELIVERY_MIN_FEE ?? 10),
    maximumFee: Number(process.env.DELIVERY_MAX_FEE ?? 120),
})

const fetchPricingConfig = async (): Promise<PricingConfig> => {
    const apiUrl = process.env.DASHBOARD_API_URL

    if (!apiUrl) return getDefaultPricingConfig()

    try {
        const response = await fetch(`${apiUrl}/api/pricing`)

        if (!response.ok) return getDefaultPricingConfig()

        const data = await response.json()
        const fallback = getDefaultPricingConfig()

        return {
            baseFee: Number(data.baseFee ?? fallback.baseFee),
            pricePerKm: Number(data.pricePerKm ?? fallback.pricePerKm),
            minimumFee: Number(data.minimumFee ?? fallback.minimumFee),
            maximumFee: Number(data.maximumFee ?? fallback.maximumFee),
        }
    } catch (error) {
        console.error('Pricing config fetch error:', error)
        return getDefaultPricingConfig()
    }
}

const parseGooglePlace = (
    place: {
        id?: string
        formattedAddress?: string
        displayName?: { text?: string }
        location?: { latitude?: number; longitude?: number }
    },
    fallbackLabel: string
): AddressSuggestion | null => {
    const label = place.displayName?.text || place.formattedAddress || fallbackLabel
    const lat = place.location?.latitude
    const lng = place.location?.longitude
    const placeId = place.id ?? ''

    if (!placeId || lat === undefined || lng === undefined) return null

    return {
        label,
        buttonLabel: toButtonLabel(label),
        placeId,
        lat,
        lng,
        source: 'GOOGLE',
    }
}

const searchGooglePlaces = async (
    textQuery: string,
    city: string,
    pageSize = 20
): Promise<AddressSuggestion[]> => {
    if (!GOOGLE_MAPS_API_KEY) return []

    const center = cityCenters[city]

    try {
        const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
                'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location',
            },
            body: JSON.stringify({
                textQuery,
                languageCode: 'ar',
                regionCode: GOOGLE_REGION_CODE,
                pageSize,
                ...(center
                    ? {
                          locationBias: {
                              circle: {
                                  center: {
                                      latitude: center.lat,
                                      longitude: center.lng,
                                  },
                                  radius: 35000,
                              },
                          },
                      }
                    : {}),
            }),
        })

        const data = await response.json()

        if (!response.ok) {
            console.error('[GOOGLE_PLACES_ERROR]', {
                status: response.status,
                data,
            })
            return []
        }

        const places = Array.isArray(data.places) ? data.places : []

        return places
            .map((place) => parseGooglePlace(place, textQuery))
            .filter((place): place is AddressSuggestion => place !== null)
    } catch (error) {
        console.error('Google Places search error:', error)
        return []
    }
}

const fetchCityAreasFromGoogle = async (city: string): Promise<AddressSuggestion[]> => {
    const queries = [
        `أحياء ${city}`,
        `مناطق ${city}`,
        `${city} فلسطين`,
    ]

    const unique = new Map<string, AddressSuggestion>()

    for (const query of queries) {
        const results = await searchGooglePlaces(query, city, 20)

        for (const result of results) {
            if (!unique.has(result.placeId)) {
                unique.set(result.placeId, result)
            }
        }

        if (unique.size >= 12) break
    }

    return Array.from(unique.values()).slice(0, 12)
}

const createNeedsReviewLocation = (city: string): ResolvedLocation => ({
    label: `${city} - يحتاج مراجعة`,
    placeId: null,
    lat: null,
    lng: null,
    source: 'NEEDS_REVIEW',
    originalText: city,
    city,
})

const getSelectedChoice = <T>(
    selectedText: string,
    page: PaginatedPage<T>,
    getOriginalLabel: (item: T) => string
): T | null => {
    const selected = selectedText.trim()
    const normalizedSelected = normalizeText(selected)
    const selectionNumber = parseSelectionNumber(selected)

    if (selectionNumber !== null) {
        return page.choices.find((choice) => choice.number === selectionNumber)?.item ?? null
    }

    return (
        page.choices.find((choice) => {
            return (
                choice.buttonLabel === selected ||
                normalizeText(choice.buttonLabel) === normalizedSelected ||
                normalizeText(getOriginalLabel(choice.item)) === normalizedSelected
            )
        })?.item ?? null
    )
}

const getSelectedCityFromCurrentPage = (
    text: string,
    page: number,
    kind: SelectionKind
) => {
    return getSelectedChoice(text, buildCityPage(page, kind), (city) => city)
}

const getSelectedAreaFromCurrentPage = (
    text: string,
    areas: AddressSuggestion[],
    page: number,
    city: string,
    kind: SelectionKind
) => {
    return getSelectedChoice(
        text,
        buildAreaPage(areas, page, city, kind),
        (area) => area.label
    )
}

const handleCityStep = async (
    ctxBody: string,
    state: BotState,
    flowDynamic: FlowDynamicFn,
    kind: SelectionKind
) => {
    const pageKey = `${kind}CityPage`
    const cityKey = `${kind}City`
    const areaPageKey = `${kind}AreaPage`
    const areaOptionsKey = `${kind}AreaOptions`
    const locationKey = `${kind}Location`
    const areaSkipKey = `${kind}AreaSkip`
    const nextStep: BotStep = kind === 'pickup' ? 'PICKUP_AREA' : 'DROPOFF_AREA'

    const selected = ctxBody.trim()
    let page = Number(state.get(pageKey) ?? 0)
    const pages = getCityPages()

    if (isSameCommand(selected, NEXT_BUTTON)) {
        page = Math.min(page + 1, pages.length - 1)
        await state.update({ [pageKey]: page })
        await sendPagedMessage(flowDynamic, buildCityPage(page, kind))
        return
    }

    if (isSameCommand(selected, PREV_BUTTON)) {
        page = Math.max(page - 1, 0)
        await state.update({ [pageKey]: page })
        await sendPagedMessage(flowDynamic, buildCityPage(page, kind))
        return
    }

    const city = getSelectedCityFromCurrentPage(selected, page, kind)

    if (!city) {
        const currentPage = buildCityPage(page, kind)
        await sendPagedMessage(flowDynamic, {
            ...currentPage,
            body: `${currentPage.body}\n\nاختر رقمًا أو زرًا من القائمة فقط.`,
        })
        return
    }

    await state.update({
        [cityKey]: city,
        [pageKey]: 0,
        [areaPageKey]: 0,
        [areaOptionsKey]: null,
        [locationKey]: null,
        [areaSkipKey]: false,
        step: nextStep,
    })

    const areas = await fetchCityAreasFromGoogle(city)

    if (!areas.length) {
        await state.update({
            [locationKey]: createNeedsReviewLocation(city),
            [areaSkipKey]: true,
        })

        await sendPagedMessage(flowDynamic, {
            body: `لم نجد مناطق لمدينة ${city}.\nسيتم مراجعة العنوان يدويًا.`,
            buttons: [{ body: CONTINUE_BUTTON }],
            items: [],
            choices: [],
        })
        return
    }

    await state.update({
        [areaOptionsKey]: areas,
        [areaPageKey]: 0,
        [areaSkipKey]: false,
    })

    await sendPagedMessage(flowDynamic, buildAreaPage(areas, 0, city, kind))
}

const handleAreaStep = async (
    ctxBody: string,
    state: BotState,
    flowDynamic: FlowDynamicFn,
    kind: SelectionKind
) => {
    const pageKey = `${kind}AreaPage`
    const cityKey = `${kind}City`
    const locationKey = `${kind}Location`
    const optionsKey = `${kind}AreaOptions`
    const skipKey = `${kind}AreaSkip`
    const nextStep: BotStep = kind === 'pickup' ? 'DROPOFF_CITY' : 'ASK_DETAILS'

    const selected = ctxBody.trim()
    const city = state.get(cityKey) as string
    const areas = (state.get(optionsKey) as AddressSuggestion[] | null) ?? []

    if (state.get(skipKey)) {
        if (!isSameCommand(selected, CONTINUE_BUTTON)) {
            await sendPagedMessage(flowDynamic, {
                body: 'اضغط متابعة ➡️ للاستمرار.',
                buttons: [{ body: CONTINUE_BUTTON }],
                items: [],
                choices: [],
            })
            return
        }

        await state.update({ step: nextStep })

        if (kind === 'pickup') {
            await state.update({
                dropoffCityPage: 0,
                dropoffCity: null,
                dropoffAreaPage: 0,
                dropoffAreaOptions: null,
                dropoffLocation: null,
                dropoffAreaSkip: false,
            })

            await sendPagedMessage(flowDynamic, buildCityPage(0, 'dropoff'))
            return
        }

        await sendText(
            flowDynamic,
            [
                'اكتب تفاصيل الطلب الآن:',
                '',
                'مثال: أكل من مطعم، طرد، أغراض من سوبرماركت.',
            ].join('\n')
        )
        return
    }

    if (!areas.length) {
        await state.update({
            [locationKey]: createNeedsReviewLocation(city),
            [skipKey]: true,
        })

        await sendPagedMessage(flowDynamic, {
            body: `لم نجد مناطق لمدينة ${city}.\nسيتم مراجعة العنوان يدويًا.`,
            buttons: [{ body: CONTINUE_BUTTON }],
            items: [],
            choices: [],
        })
        return
    }

    let page = Number(state.get(pageKey) ?? 0)
    const pages = getAreaPages(areas)

    if (isSameCommand(selected, NEXT_BUTTON)) {
        page = Math.min(page + 1, pages.length - 1)
        await state.update({ [pageKey]: page })
        await sendPagedMessage(flowDynamic, buildAreaPage(areas, page, city, kind))
        return
    }

    if (isSameCommand(selected, PREV_BUTTON)) {
        page = Math.max(page - 1, 0)
        await state.update({ [pageKey]: page })
        await sendPagedMessage(flowDynamic, buildAreaPage(areas, page, city, kind))
        return
    }

    const area = getSelectedAreaFromCurrentPage(selected, areas, page, city, kind)

    if (!area) {
        const currentPage = buildAreaPage(areas, page, city, kind)
        await sendPagedMessage(flowDynamic, {
            ...currentPage,
            body: `${currentPage.body}\n\nاختر رقمًا أو زرًا من القائمة فقط.`,
        })
        return
    }

    await state.update({
        [locationKey]: {
            label: area.label,
            placeId: area.placeId,
            lat: area.lat,
            lng: area.lng,
            source: 'GOOGLE',
            originalText: area.label,
            city,
        },
        [optionsKey]: null,
        step: nextStep,
    })

    if (kind === 'pickup') {
        await state.update({
            dropoffCityPage: 0,
            dropoffCity: null,
            dropoffAreaPage: 0,
            dropoffAreaOptions: null,
            dropoffLocation: null,
            dropoffAreaSkip: false,
        })

        await sendPagedMessage(flowDynamic, buildCityPage(0, 'dropoff'))
        return
    }

    await sendText(
        flowDynamic,
        [
            'اكتب تفاصيل الطلب الآن:',
            '',
            'مثال: أكل من مطعم، طرد، أغراض من سوبرماركت.',
        ].join('\n')
    )
}

const getRouteDistance = async (
    pickup: ResolvedLocation,
    dropoff: ResolvedLocation
): Promise<RouteResult> => {
    if (
        pickup.lat === null ||
        pickup.lng === null ||
        dropoff.lat === null ||
        dropoff.lng === null
    ) {
        return {
            distanceMeters: null,
            durationText: null,
            source: 'NEEDS_REVIEW',
        }
    }

    if (!GOOGLE_MAPS_API_KEY) {
        return {
            distanceMeters: null,
            durationText: null,
            source: 'NEEDS_REVIEW',
        }
    }

    try {
        const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
                'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration',
            },
            body: JSON.stringify({
                origin: {
                    location: {
                        latLng: {
                            latitude: pickup.lat,
                            longitude: pickup.lng,
                        },
                    },
                },
                destination: {
                    location: {
                        latLng: {
                            latitude: dropoff.lat,
                            longitude: dropoff.lng,
                        },
                    },
                },
                travelMode: 'DRIVE',
                routingPreference: 'TRAFFIC_UNAWARE',
                languageCode: 'ar',
                units: 'METRIC',
            }),
        })

        const data = await response.json()

        if (!response.ok) {
            console.error('[GOOGLE_ROUTES_ERROR]', {
                status: response.status,
                data,
            })
            return {
                distanceMeters: null,
                durationText: null,
                source: 'NEEDS_REVIEW',
            }
        }

        const route = data.routes?.[0]

        if (!route?.distanceMeters) {
            return {
                distanceMeters: null,
                durationText: null,
                source: 'NEEDS_REVIEW',
            }
        }

        const seconds = Number(String(route.duration ?? '0s').replace('s', ''))
        const minutes = seconds > 0 ? Math.ceil(seconds / 60) : null

        return {
            distanceMeters: route.distanceMeters,
            durationText: minutes ? `${minutes} دقيقة` : null,
            source: 'GOOGLE_ROUTES',
        }
    } catch (error) {
        console.error('Google Routes error:', error)

        return {
            distanceMeters: null,
            durationText: null,
            source: 'NEEDS_REVIEW',
        }
    }
}

const calculateDeliveryFee = (
    distanceMeters: number | null,
    pricing: PricingConfig
) => {
    if (distanceMeters === null) return null

    const distanceKm = distanceMeters / 1000
    const rawFee = pricing.baseFee + distanceKm * pricing.pricePerKm
    const roundedFee = Math.ceil(rawFee)

    return Math.min(
        Math.max(roundedFee, pricing.minimumFee),
        pricing.maximumFee
    )
}

const formatDistance = (distanceMeters: number | null) => {
    if (distanceMeters === null) return 'قيد المراجعة'
    return `${(distanceMeters / 1000).toFixed(1)} كم`
}

const needsAddressReview = (
    pickup: ResolvedLocation,
    dropoff: ResolvedLocation,
    route: RouteResult,
    deliveryFee: number | null
) => {
    return (
        pickup.source === 'NEEDS_REVIEW' ||
        dropoff.source === 'NEEDS_REVIEW' ||
        route.source === 'NEEDS_REVIEW' ||
        deliveryFee === null
    )
}

const buildOrderSummary = async (state: BotState) => {
    const customerName = state.get('customerName')
    const customerPhone = state.get('customerPhone')
    const pickupLocation = state.get('pickupLocation') as ResolvedLocation
    const dropoffLocation = state.get('dropoffLocation') as ResolvedLocation
    const details = state.get('details')

    const pricing = await fetchPricingConfig()
    const route = await getRouteDistance(pickupLocation, dropoffLocation)
    const deliveryFee = calculateDeliveryFee(route.distanceMeters, pricing)
    const reviewNeeded = needsAddressReview(
        pickupLocation,
        dropoffLocation,
        route,
        deliveryFee
    )

    await state.update({
        route,
        deliveryFee,
        pricing,
        reviewNeeded,
    })

    return [
        'ملخص الطلب:',
        '',
        `اسم العميل: ${customerName}`,
        `رقم الهاتف: ${customerPhone}`,
        '',
        `مدينة الاستلام: ${pickupLocation.city}`,
        `منطقة الاستلام: ${pickupLocation.label}`,
        `مدينة التسليم: ${dropoffLocation.city}`,
        `منطقة التسليم: ${dropoffLocation.label}`,
        '',
        `تفاصيل الطلب: ${details}`,
        `المسافة: ${formatDistance(route.distanceMeters)}`,
        route.durationText ? `الوقت المتوقع: ${route.durationText}` : null,
        deliveryFee !== null
            ? `تكلفة التوصيل: ${deliveryFee} شيكل`
            : 'تكلفة التوصيل: قيد المراجعة',
        '',
        reviewNeeded
            ? 'ملاحظة: العنوان يحتاج مراجعة قبل تحويل الطلب للكابتن.'
            : null,
        '',
        'اضغط تأكيد ✅ لإنشاء الطلب، أو إلغاء ❌.',
    ].filter(Boolean).join('\n')
}

const sendOrderSummary = async (flowDynamic: FlowDynamicFn, state: BotState) => {
    const summary = await buildOrderSummary(state)

    await sendPagedMessage(flowDynamic, {
        body: summary,
        buttons: [
            { body: CONFIRM_BUTTON },
            { body: CANCEL_BUTTON },
        ],
    })
}

const resetAndStart = async (state: BotState, flowDynamic: FlowDynamicFn) => {
    await state.clear()

    await state.update({
        step: 'ASK_NAME',
    })

    await sendText(
        flowDynamic,
        [
            'مرحبا بك في بوت التوصيل 👋',
            '',
            'اكتب اسمك الكامل:',
        ].join('\n')
    )
}

const handleIncoming = async (
    ctx: { body: string; from: string },
    helpers: {
        state: BotState
        flowDynamic: FlowDynamicFn
    }
) => {
    const { state, flowDynamic } = helpers
    const body = ctx.body.trim()
    const currentStep = (state.get('step') as BotStep | undefined) ?? null

    console.log('[BOT_INCOMING]', {
        from: ctx.from,
        step: currentStep,
        body,
    })

    if (isCancel(body)) {
        await state.clear()
        await sendText(flowDynamic, 'تم إلغاء الطلب. أرسل "طلب" للبدء من جديد.')
        return
    }

    if (isStartOrder(body)) {
        await resetAndStart(state, flowDynamic)
        return
    }

    if (!currentStep) {
        if (isGreetingOrInquiry(body)) {
            await sendText(flowDynamic, buildWelcomeMessage())
            return
        }

        await sendText(
            flowDynamic,
            [
                'أهلًا وسهلًا 👋',
                '',
                'لبدء طلب توصيل جديد اكتب:',
                'طلب',
            ].join('\n')
        )
        return
    }

    if (currentStep === 'ASK_NAME') {
        if (isGreetingOrInquiry(body)) {
            await sendText(
                flowDynamic,
                [
                    'أهلًا وسهلًا 👋',
                    '',
                    'لبدء الطلب، اكتب اسمك الكامل:',
                ].join('\n')
            )
            return
        }

        if (body.length < 2) {
            await sendText(flowDynamic, 'اكتب الاسم بشكل أوضح.')
            return
        }

        await state.update({
            customerName: body,
            step: 'ASK_PHONE',
        })

        await sendText(
            flowDynamic,
            [
                'اكتب رقم هاتفك للتواصل:',
                '',
                'مثال: 0591234567',
            ].join('\n')
        )
        return
    }

    if (currentStep === 'ASK_PHONE') {
        const customerPhone = cleanPhone(body)

        if (!isValidPhone(customerPhone)) {
            await sendText(flowDynamic, 'رقم الهاتف غير صحيح. اكتب رقم مثل: 0591234567')
            return
        }

        console.log('[ASK_PHONE_OK] moving to pickup city', {
            customerPhone,
        })

        await state.update({
            customerPhone,
            step: 'PICKUP_CITY',
            pickupCityPage: 0,
            pickupCity: null,
            pickupAreaPage: 0,
            pickupAreaOptions: null,
            pickupLocation: null,
            pickupAreaSkip: false,
        })

        await sendPagedMessage(flowDynamic, buildCityPage(0, 'pickup'))
        return
    }

    if (currentStep === 'PICKUP_CITY') {
        await handleCityStep(body, state, flowDynamic, 'pickup')
        return
    }

    if (currentStep === 'PICKUP_AREA') {
        await handleAreaStep(body, state, flowDynamic, 'pickup')
        return
    }

    if (currentStep === 'DROPOFF_CITY') {
        await handleCityStep(body, state, flowDynamic, 'dropoff')
        return
    }

    if (currentStep === 'DROPOFF_AREA') {
        await handleAreaStep(body, state, flowDynamic, 'dropoff')
        return
    }

    if (currentStep === 'ASK_DETAILS') {
        if (body.length < 3) {
            await sendText(flowDynamic, 'اكتب تفاصيل الطلب بشكل أوضح.')
            return
        }

        await state.update({
            details: body,
            step: 'CONFIRM_ORDER',
        })

        await sendOrderSummary(flowDynamic, state)
        return
    }

    if (currentStep === 'CONFIRM_ORDER') {
        if (!isConfirm(body)) {
            await sendPagedMessage(flowDynamic, {
                body: 'لم يتم إنشاء الطلب بعد. اضغط تأكيد ✅ أو إلغاء ❌.',
                buttons: [
                    { body: CONFIRM_BUTTON },
                    { body: CANCEL_BUTTON },
                ],
            })
            return
        }

        const customerName = state.get('customerName')
        const customerPhone = state.get('customerPhone')
        const pickupLocation = state.get('pickupLocation') as ResolvedLocation
        const dropoffLocation = state.get('dropoffLocation') as ResolvedLocation
        const details = state.get('details')
        const route = state.get('route') as RouteResult
        const deliveryFee = state.get('deliveryFee')
        const reviewNeeded = state.get('reviewNeeded')
        const orderNumber = createOrderNumber()
        const orderStatus = reviewNeeded ? 'NEEDS_ADDRESS_REVIEW' : 'READY_FOR_CAPTAIN'

        const orderPayload = {
            orderNumber,
            customerName,
            customerPhone,
            pickupCity: pickupLocation.city,
            pickupAddress: pickupLocation.label,
            pickupPlaceId: pickupLocation.placeId,
            pickupLat: pickupLocation.lat,
            pickupLng: pickupLocation.lng,
            pickupSource: pickupLocation.source,
            dropoffCity: dropoffLocation.city,
            dropoffAddress: dropoffLocation.label,
            dropoffPlaceId: dropoffLocation.placeId,
            dropoffLat: dropoffLocation.lat,
            dropoffLng: dropoffLocation.lng,
            dropoffSource: dropoffLocation.source,
            details,
            distanceMeters: route.distanceMeters,
            durationText: route.durationText,
            routeSource: route.source,
            deliveryFee,
            source: 'WHATSAPP',
            whatsappNumber: ctx.from,
            status: orderStatus,
        }

        console.log('NEW_WHATSAPP_ORDER', orderPayload)

        await sendText(
            flowDynamic,
            [
                'تم إنشاء الطلب بنجاح ✅',
                '',
                `رقم الطلب: ${orderNumber}`,
                `اسم العميل: ${customerName}`,
                `رقم الهاتف: ${customerPhone}`,
                '',
                `الاستلام: ${pickupLocation.label} (${pickupLocation.city})`,
                `التسليم: ${dropoffLocation.label} (${dropoffLocation.city})`,
                `التفاصيل: ${details}`,
                `المسافة: ${formatDistance(route.distanceMeters)}`,
                deliveryFee !== null
                    ? `تكلفة التوصيل: ${deliveryFee} شيكل`
                    : 'تكلفة التوصيل: قيد المراجعة',
                '',
                reviewNeeded
                    ? 'سيتم مراجعة العنوان قبل تحويل الطلب للكابتن.'
                    : 'سيتم تحويل الطلب إلى الكابتن قريبًا.',
            ].filter(Boolean).join('\n')
        )

        await state.clear()
        return
    }

    await resetAndStart(state, flowDynamic)
}

export async function runConversationSelfTest() {
    const stateData: Record<string, unknown> = {}
    const replies: string[] = []

    const state: BotState = {
        get: (key) => stateData[key],
        update: async (data) => {
            Object.assign(stateData, data)
        },
        clear: async () => {
            for (const key of Object.keys(stateData)) {
                delete stateData[key]
            }
        },
    }

    const flowDynamic: FlowDynamicFn = async (messages) => {
        for (const message of messages) {
            if (typeof message === 'string') {
                replies.push(message)
                continue
            }

            const parts = [message.body ?? '']
            if (message.buttons?.length) {
                parts.push(message.buttons.map((button) => button.body).join(' | '))
            }
            replies.push(parts.filter(Boolean).join('\n'))
        }
    }

    const send = async (text: string) => {
        await handleIncoming({ body: text, from: 'test-user' }, { state, flowDynamic })
    }

    const cityPage = buildCityPage(0, 'pickup')
    if (!cityPage.body.includes('1. القدس')) {
        throw new Error('numbered city list missing')
    }

    const cityByNumber = getSelectedChoice('1', cityPage, (city) => city)
    if (cityByNumber !== 'القدس') {
        throw new Error(`expected القدس from number 1, got ${cityByNumber}`)
    }

    const arabicNumber = getSelectedChoice('١', cityPage, (city) => city)
    if (arabicNumber !== 'القدس') {
        throw new Error(`expected القدس from arabic number, got ${arabicNumber}`)
    }

    await send('طلب')
    if (stateData.step !== 'ASK_NAME') throw new Error('step should be ASK_NAME')

    await send('محمد أحمد')
    if (stateData.step !== 'ASK_PHONE') throw new Error('step should be ASK_PHONE')

    await send('0591234567')
    if (stateData.step !== 'PICKUP_CITY') throw new Error('step should be PICKUP_CITY')
    if (!replies.some((reply) => reply.includes('1. القدس'))) {
        throw new Error('pickup city list should include numbered options')
    }

    await send('1')
    if (stateData.step !== 'PICKUP_AREA') throw new Error('step should be PICKUP_AREA after city 1')

    if (stateData.pickupAreaSkip) {
        await send(CONTINUE_BUTTON)
    } else {
        await send('1')
    }
    if (stateData.step !== 'DROPOFF_CITY') throw new Error('step should be DROPOFF_CITY')

    await send('2')
    if (stateData.dropoffCity !== 'رام الله') {
        throw new Error(`expected dropoff city رام الله, got ${stateData.dropoffCity}`)
    }

    if (stateData.dropoffAreaSkip) {
        await send(CONTINUE_BUTTON)
    } else {
        await send('1')
    }
    if (stateData.step !== 'ASK_DETAILS') throw new Error('step should be ASK_DETAILS')

    await send('طرد من الصيدلية')
    if (stateData.step !== 'CONFIRM_ORDER') throw new Error('step should be CONFIRM_ORDER')
    if (!replies.some((reply) => reply.includes('ملخص الطلب'))) {
        throw new Error('summary should be shown before confirm')
    }

    const ordersBeforeConfirm = replies.filter((reply) => reply.includes('تم إنشاء الطلب بنجاح')).length
    await send('مرحبا')
    const ordersAfterInvalid = replies.filter((reply) => reply.includes('تم إنشاء الطلب بنجاح')).length
    if (ordersAfterInvalid !== ordersBeforeConfirm) {
        throw new Error('order must not be created before confirm')
    }

    await send(CONFIRM_BUTTON)
    if (!replies.some((reply) => reply.includes('تم إنشاء الطلب بنجاح'))) {
        throw new Error('order should be created after confirm')
    }

    console.log('[BOT_SELF_TEST_OK] numbered city/area flow passed')
}

const startFlow = addKeyword<Provider, Database>(EVENTS.WELCOME)
    .addAction(async (ctx, { state, flowDynamic }) => {
        await handleIncoming(ctx, { state, flowDynamic })
    })

const main = async () => {
    if (process.env.BOT_SELF_TEST === '1') {
        await runConversationSelfTest()
        return
    }

    const adapterFlow = createFlow([startFlow])

    const adapterProvider = createProvider(Provider, {
        version: [2, 3000, 1035824857],
    })

    const adapterDB = new Database()

    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    })

    httpServer(Number(PORT))

    console.log(`[BOT_READY] HTTP Server running on http://localhost:${PORT}`)
}

main().catch((error) => {
    console.error('[BOT_FATAL_ERROR]', error)
    process.exit(1)
})