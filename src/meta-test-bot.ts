import 'dotenv/config'
import express from 'express'

const PORT = Number(process.env.PORT ?? 3008)
const META_API_VERSION = 'v20.0'

const readEnv = (primary: string, ...fallbacks: string[]) => {
    for (const key of [primary, ...fallbacks]) {
        const value = process.env[key]?.trim()
        if (value) return value
    }

    return undefined
}

const META_WHATSAPP_TOKEN = readEnv('META_WHATSAPP_TOKEN')
const META_WHATSAPP_PHONE_NUMBER_ID = readEnv(
    'META_WHATSAPP_PHONE_NUMBER_ID',
    'META_PHONE_NUMBER_ID'
)
const META_WHATSAPP_VERIFY_TOKEN = readEnv(
    'META_WHATSAPP_VERIFY_TOKEN',
    'META_VERIFY_TOKEN'
)

const NEXT_BUTTON = 'التالي ➡️'
const PREV_BUTTON = 'السابق ⬅️'

const cities = [
    'القدس',
    'رام الله',
    'بيت لحم',
    'الخليل',
    'نابلس',
    'جنين',
    'أريحا',
]

type Step = 'IDLE' | 'ASK_NAME' | 'ASK_PHONE' | 'PICKUP_CITY'

type Session = {
    step: Step
    name?: string
    phone?: string
    pickupCityPage?: number
}

const sessions = new Map<string, Session>()

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

const isValidPhone = (phone: string) => {
    const cleaned = cleanPhone(phone)
    return /^05\d{8}$/.test(cleaned) || /^9725\d{8}$/.test(cleaned)
}

const isStartOrder = (text: string) => {
    const normalized = normalizeText(text)

    return [
        'طلب',
        'طلب جديد',
        'ابدا',
        'ابدأ',
        'اطلب',
        'بدي طلب',
        'اريد طلب',
        'اعمل طلب',
    ].map(normalizeText).includes(normalized)
}

const isGreetingOrInquiry = (text: string) => {
    const normalized = normalizeText(text)

    const phrases = [
        'مرحبا',
        'مرحبه',
        'اهلا',
        'اهلين',
        'السلام عليكم',
        'سلام عليكم',
        'سلام',
        'صباح الخير',
        'مساء الخير',
        'يعطيك العافيه',
        'يعطيكم العافيه',
        'يعطيك العافية',
        'لو سمحت',
        'ممكن',
        'عندي سؤال',
        'سؤال',
        'استفسار',
        'قديش التوصيل',
        'وين بتوصلوا',
        'في توصيل',
    ].map(normalizeText)

    return phrases.some((phrase) => normalized.includes(phrase))
}

const requireMetaConfig = () => {
    if (!META_WHATSAPP_VERIFY_TOKEN) {
        throw new Error(
            'META_WHATSAPP_VERIFY_TOKEN is missing in .env (fallback: META_VERIFY_TOKEN)'
        )
    }

    if (!META_WHATSAPP_TOKEN) {
        throw new Error('META_WHATSAPP_TOKEN is missing in .env')
    }

    if (!META_WHATSAPP_PHONE_NUMBER_ID) {
        throw new Error(
            'META_WHATSAPP_PHONE_NUMBER_ID is missing in .env (fallback: META_PHONE_NUMBER_ID)'
        )
    }

    return {
        token: META_WHATSAPP_TOKEN,
        phoneNumberId: META_WHATSAPP_PHONE_NUMBER_ID,
    }
}

const sendMetaText = async (to: string, body: string) => {
    const { token, phoneNumberId } = requireMetaConfig()

    const response = await fetch(
        `https://graph.facebook.com/${META_API_VERSION}/${phoneNumberId}/messages`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                to,
                type: 'text',
                text: {
                    body,
                },
            }),
        }
    )

    const data = await response.json()

    if (!response.ok) {
        console.error('[META_SEND_TEXT_ERROR]', data)
        throw new Error('Failed to send text message')
    }

    return data
}

const trimButtonTitle = (title: string) => {
    return title.length > 20 ? title.slice(0, 20) : title
}

const sendMetaButtons = async (
    to: string,
    body: string,
    buttons: Array<{ id: string; title: string }>
) => {
    const { token, phoneNumberId } = requireMetaConfig()

    if (buttons.length < 1 || buttons.length > 3) {
        throw new Error('Meta WhatsApp buttons must be between 1 and 3')
    }

    const response = await fetch(
        `https://graph.facebook.com/${META_API_VERSION}/${phoneNumberId}/messages`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                to,
                type: 'interactive',
                interactive: {
                    type: 'button',
                    body: {
                        text: body,
                    },
                    action: {
                        buttons: buttons.map((button) => ({
                            type: 'reply',
                            reply: {
                                id: button.id,
                                title: trimButtonTitle(button.title),
                            },
                        })),
                    },
                },
            }),
        }
    )

    const data = await response.json()

    if (!response.ok) {
        console.error('[META_SEND_BUTTONS_ERROR]', data)
        throw new Error('Failed to send buttons message')
    }

    return data
}

const buildCityButtons = (page: number) => {
    if (page <= 0) {
        return {
            page: 0,
            body: 'اختر مدينة الاستلام:',
            buttons: [
                { id: 'PICKUP_CITY:القدس', title: 'القدس' },
                { id: 'PICKUP_CITY:رام الله', title: 'رام الله' },
                { id: 'PICKUP_CITY_PAGE:NEXT', title: NEXT_BUTTON },
            ],
        }
    }

    if (page === 1) {
        return {
            page: 1,
            body: 'اختر مدينة الاستلام:',
            buttons: [
                { id: 'PICKUP_CITY:بيت لحم', title: 'بيت لحم' },
                { id: 'PICKUP_CITY:الخليل', title: 'الخليل' },
                { id: 'PICKUP_CITY_PAGE:NEXT', title: NEXT_BUTTON },
            ],
        }
    }

    if (page === 2) {
        return {
            page: 2,
            body: 'اختر مدينة الاستلام:',
            buttons: [
                { id: 'PICKUP_CITY:نابلس', title: 'نابلس' },
                { id: 'PICKUP_CITY:جنين', title: 'جنين' },
                { id: 'PICKUP_CITY_PAGE:NEXT', title: NEXT_BUTTON },
            ],
        }
    }

    return {
        page: 3,
        body: 'اختر مدينة الاستلام:',
        buttons: [
            { id: 'PICKUP_CITY:أريحا', title: 'أريحا' },
            { id: 'PICKUP_CITY_PAGE:PREV', title: PREV_BUTTON },
        ],
    }
}

const sendPickupCityPage = async (to: string, session: Session) => {
    const page = Number(session.pickupCityPage ?? 0)
    const cityPage = buildCityButtons(page)

    session.pickupCityPage = cityPage.page

    console.log('[META_BUTTONS] sending city page', {
        to,
        page: cityPage.page,
        buttons: cityPage.buttons,
    })

    await sendMetaButtons(to, cityPage.body, cityPage.buttons)
}

const welcomeMessage = () => {
    return [
        'أهلًا وسهلًا في بوت التوصيل 👋',
        '',
        'أقدر أساعدك بإنشاء طلب توصيل.',
        '',
        'لبدء طلب جديد اكتب:',
        'طلب',
    ].join('\n')
}

const handleIncoming = async (from: string, textOrButtonId: string) => {
    const incoming = textOrButtonId.trim()
    const session = sessions.get(from) ?? { step: 'IDLE' as Step }

    console.log('[META_INCOMING]', {
        from,
        step: session.step,
        incoming,
    })

    if (normalizeText(incoming) === 'الغاء' || normalizeText(incoming) === 'الغى') {
        sessions.delete(from)
        await sendMetaText(from, 'تم إلغاء الطلب. أرسل "طلب" للبدء من جديد.')
        return
    }

    if (isStartOrder(incoming)) {
        const newSession: Session = {
            step: 'ASK_NAME',
        }

        sessions.set(from, newSession)

        await sendMetaText(
            from,
            [
                'مرحبا بك في بوت التوصيل 👋',
                '',
                'اكتب اسمك الكامل:',
            ].join('\n')
        )
        return
    }

    if (session.step === 'IDLE') {
        if (isGreetingOrInquiry(incoming)) {
            await sendMetaText(from, welcomeMessage())
            return
        }

        await sendMetaText(from, 'أهلًا وسهلًا 👋\nلبدء طلب توصيل جديد اكتب: طلب')
        return
    }

    if (session.step === 'ASK_NAME') {
        if (isGreetingOrInquiry(incoming)) {
            await sendMetaText(from, 'أهلًا وسهلًا 👋\nلبدء الطلب، اكتب اسمك الكامل:')
            return
        }

        if (incoming.length < 2) {
            await sendMetaText(from, 'اكتب الاسم بشكل أوضح.')
            return
        }

        session.name = incoming
        session.step = 'ASK_PHONE'
        sessions.set(from, session)

        await sendMetaText(
            from,
            [
                'اكتب رقم هاتفك للتواصل:',
                '',
                'مثال: 0591234567',
            ].join('\n')
        )
        return
    }

    if (session.step === 'ASK_PHONE') {
        const phone = cleanPhone(incoming)

        if (!isValidPhone(phone)) {
            await sendMetaText(from, 'رقم الهاتف غير صحيح. اكتب رقم مثل: 0591234567')
            return
        }

        session.phone = phone
        session.step = 'PICKUP_CITY'
        session.pickupCityPage = 0
        sessions.set(from, session)

        await sendPickupCityPage(from, session)
        return
    }

    if (session.step === 'PICKUP_CITY') {
        if (incoming === 'PICKUP_CITY_PAGE:NEXT') {
            session.pickupCityPage = Math.min(Number(session.pickupCityPage ?? 0) + 1, 3)
            sessions.set(from, session)
            await sendPickupCityPage(from, session)
            return
        }

        if (incoming === 'PICKUP_CITY_PAGE:PREV') {
            session.pickupCityPage = Math.max(Number(session.pickupCityPage ?? 0) - 1, 0)
            sessions.set(from, session)
            await sendPickupCityPage(from, session)
            return
        }

        if (incoming.startsWith('PICKUP_CITY:')) {
            const city = incoming.replace('PICKUP_CITY:', '')

            await sendMetaText(
                from,
                [
                    'تم اختيار مدينة الاستلام ✅',
                    '',
                    `المدينة: ${city}`,
                    '',
                    'التجربة نجحت: أزرار Meta تعمل رسميًا.',
                    '',
                    'الخطوة التالية: نضيف أزرار المناطق بنفس الطريقة.',
                ].join('\n')
            )

            session.step = 'IDLE'
            sessions.set(from, session)
            return
        }

        await sendPickupCityPage(from, session)
        return
    }

    await sendMetaText(from, 'أرسل "طلب" للبدء من جديد.')
}

const extractIncomingMessage = (body: any) => {
    const value = body?.entry?.[0]?.changes?.[0]?.value
    const message = value?.messages?.[0]

    if (!message) return null

    const from = message.from as string | undefined

    if (!from) return null

    if (message.type === 'text') {
        return {
            from,
            textOrButtonId: String(message.text?.body ?? ''),
        }
    }

    if (message.type === 'interactive') {
        const buttonReplyId = message.interactive?.button_reply?.id

        if (buttonReplyId) {
            return {
                from,
                textOrButtonId: String(buttonReplyId),
            }
        }
    }

    return {
        from,
        textOrButtonId: '',
    }
}

const app = express()

app.use(express.json())

app.get('/', (_, res) => {
    res.send('Meta WhatsApp bot is running')
})

app.get('/webhook/meta', (req, res) => {
    const mode = req.query['hub.mode']
    const token = req.query['hub.verify_token']
    const challenge = req.query['hub.challenge']

    if (
        mode === 'subscribe' &&
        META_WHATSAPP_VERIFY_TOKEN &&
        token === META_WHATSAPP_VERIFY_TOKEN
    ) {
        console.log('[META_WEBHOOK_VERIFIED]')
        res.status(200).send(String(challenge))
        return
    }

    console.error('[META_WEBHOOK_VERIFY_FAILED]', {
        mode,
        token,
    })

    res.sendStatus(403)
})

app.post('/webhook/meta', async (req, res) => {
    res.sendStatus(200)

    try {
        const incoming = extractIncomingMessage(req.body)

        if (!incoming) {
            console.log('[META_WEBHOOK_IGNORED]', JSON.stringify(req.body))
            return
        }

        await handleIncoming(incoming.from, incoming.textOrButtonId)
    } catch (error) {
        console.error('[META_WEBHOOK_ERROR]', error)
    }
})
const server = app.listen(PORT, () => {
    console.log(`[META_BOT_READY] http://localhost:${PORT}`)
    console.log(`[META_WEBHOOK] GET/POST /webhook/meta`)
    console.log('[META_ENV]', {
        token: META_WHATSAPP_TOKEN ? `loaded length=${META_WHATSAPP_TOKEN.length}` : 'missing',
        phoneNumberId: META_WHATSAPP_PHONE_NUMBER_ID ?? 'missing',
        verifyToken: META_WHATSAPP_VERIFY_TOKEN ? `loaded length=${META_WHATSAPP_VERIFY_TOKEN.length}` : 'missing',
    })
})

server.on('error', (error) => {
    console.error('[META_SERVER_ERROR]', error)
})

process.stdin.resume()