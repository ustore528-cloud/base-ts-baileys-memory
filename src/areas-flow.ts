export const AREAS = [
    'عناتا',
    'مخيم شعفاط',
    'رأس خميس',
    'رأس شحادة',
    'ضاحية السلام',
    'كفر عقب',
    'رام الله',
]

export type AreasStep = 'ASK_PICKUP_AREA' | 'ASK_DROPOFF_AREA' | 'AWAIT_CONFIRM'

export type AreasSession = {
    step: AreasStep
    pickupArea?: string
    dropoffArea?: string
    deliveryFee?: number
}

export type AreasFlowResult = {
    messages: string[]
    session: AreasSession | null
    completed?: boolean
}

export const normalizeDigits = (text: string) => {
    return text
        .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
        .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
        .trim()
}

export const normalizeText = (text: string) => {
    return normalizeDigits(text)
        .toLowerCase()
        .replace(/[أإآ]/g, 'ا')
        .replace(/ة/g, 'ه')
        .replace(/ى/g, 'ي')
        .trim()
}

export const parseAreaSelection = (text: string) => {
    const normalized = normalizeDigits(text).trim()
    const number = Number(normalized)

    if (!Number.isInteger(number) || number < 1 || number > AREAS.length) {
        return null
    }

    return AREAS[number - 1]
}

export const formatAreaList = (title: string) => {
    const lines = AREAS.map((area, index) => `${index + 1}. ${area}`)

    return [title, ...lines].join('\n')
}

export const formatWelcomePickupMessage = () => {
    return formatAreaList('مرحبًا بك في خدمة التوصيل.\nاختر منطقة الاستلام:')
}

export const formatDropoffMessage = () => {
    return formatAreaList('اختر منطقة التسليم:')
}

export const formatInvalidAreaMessage = (phase: 'pickup' | 'dropoff') => {
    const title =
        phase === 'pickup'
            ? 'الرقم غير صحيح، اختر رقم المنطقة من القائمة.\nاختر منطقة الاستلام:'
            : 'الرقم غير صحيح، اختر رقم المنطقة من القائمة.\nاختر منطقة التسليم:'

    return formatAreaList(title)
}

export const calculateAreaDeliveryFee = (pickupArea: string, dropoffArea: string) => {
    if (pickupArea === dropoffArea) return 15
    return 25
}

export const formatOrderSummary = (
    pickupArea: string,
    dropoffArea: string,
    deliveryFee: number
) => {
    return [
        'ملخص الطلب:',
        '',
        `منطقة الاستلام: ${pickupArea}`,
        `منطقة التسليم: ${dropoffArea}`,
        `سعر التوصيل: ${deliveryFee} شيكل`,
        '',
        'أرسل "تأكيد" لإتمام الطلب.',
    ].join('\n')
}

export const isConfirmMessage = (text: string) => {
    return normalizeText(text) === 'تاكيد'
}

export const handleAreasMessage = (
    incoming: string,
    session: AreasSession | null
): AreasFlowResult => {
    const text = incoming.trim()
    const isFirstTouch = !session
    const activeSession = session ?? { step: 'ASK_PICKUP_AREA' }

    if (activeSession.step === 'ASK_PICKUP_AREA') {
        const pickupArea = parseAreaSelection(text)

        if (!pickupArea) {
            return {
                messages: [
                    isFirstTouch
                        ? formatWelcomePickupMessage()
                        : formatInvalidAreaMessage('pickup'),
                ],
                session: activeSession,
            }
        }

        return {
            messages: [formatDropoffMessage()],
            session: {
                step: 'ASK_DROPOFF_AREA',
                pickupArea,
            },
        }
    }

    if (activeSession.step === 'ASK_DROPOFF_AREA') {
        const dropoffArea = parseAreaSelection(text)

        if (!dropoffArea) {
            return {
                messages: [formatInvalidAreaMessage('dropoff')],
                session: activeSession,
            }
        }

        const pickupArea = activeSession.pickupArea as string
        const deliveryFee = calculateAreaDeliveryFee(pickupArea, dropoffArea)

        return {
            messages: [formatOrderSummary(pickupArea, dropoffArea, deliveryFee)],
            session: {
                step: 'AWAIT_CONFIRM',
                pickupArea,
                dropoffArea,
                deliveryFee,
            },
        }
    }

    if (activeSession.step === 'AWAIT_CONFIRM') {
        if (isConfirmMessage(text)) {
            const pickupArea = activeSession.pickupArea as string
            const dropoffArea = activeSession.dropoffArea as string
            const deliveryFee = activeSession.deliveryFee as number

            return {
                messages: [
                    [
                        'تم إنشاء الطلب بنجاح ✅',
                        '',
                        `منطقة الاستلام: ${pickupArea}`,
                        `منطقة التسليم: ${dropoffArea}`,
                        `سعر التوصيل: ${deliveryFee} شيكل`,
                        '',
                        'سيتم التواصل معك قريبًا.',
                    ].join('\n'),
                ],
                session: null,
                completed: true,
            }
        }

        const pickupArea = activeSession.pickupArea as string
        const dropoffArea = activeSession.dropoffArea as string
        const deliveryFee = activeSession.deliveryFee as number

        return {
            messages: [
                'لم يتم التأكيد بعد. أرسل "تأكيد" لإتمام الطلب.',
                formatOrderSummary(pickupArea, dropoffArea, deliveryFee),
            ],
            session: activeSession,
        }
    }

    return {
        messages: [formatWelcomePickupMessage()],
        session: { step: 'ASK_PICKUP_AREA' },
    }
}
