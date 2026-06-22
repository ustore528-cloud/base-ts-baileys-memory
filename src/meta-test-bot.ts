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

const META_WHATSAPP_TOKEN = readEnv(
    'META_WHATSAPP_TOKEN',
    'META_WHATSAPP_ACCESS_TOKEN'
)
const META_WHATSAPP_PHONE_NUMBER_ID = readEnv(
    'META_WHATSAPP_PHONE_NUMBER_ID',
    'META_PHONE_NUMBER_ID'
)
const META_WHATSAPP_VERIFY_TOKEN = readEnv(
    'META_WHATSAPP_VERIFY_TOKEN',
    'META_VERIFY_TOKEN'
)

type CityKey = 'jerusalem' | 'ramallah'

type Step =
    | 'PICKUP_CITY'
    | 'PICKUP_AREA'
    | 'DROPOFF_CITY'
    | 'DROPOFF_AREA'
    | 'DETAILS'
    | 'CONFIRM'

type BotSession = {
    step: Step
    pickupCity?: CityKey
    pickupArea?: string
    dropoffCity?: CityKey
    dropoffArea?: string
    details?: string
}

type ListRow = {
    id: string
    title: string
    description?: string
}

const cities: Array<{ key: CityKey; title: string; description?: string }> = [
    {
        key: 'jerusalem',
        title: 'القدس',
        description: 'عناتا، شعفاط، كفر عقب...',
    },
    {
        key: 'ramallah',
        title: 'رام الله',
        description: 'رام الله، البيرة، بيتونيا...',
    },
]

const areasByCity: Record<CityKey, string[]> = {
    jerusalem: [
        'عناتا',
        'مخيم شعفاط',
        'رأس خميس',
        'رأس شحادة',
        'ضاحية السلام',
        'كفر عقب',
        'شعفاط',
        'بيت حنينا',
        'حزما',
    ],
    ramallah: ['رام الله', 'البيرة', 'بيتونيا', 'سردا', 'الماصيون'],
}

const cityTitle = (key?: CityKey) => cities.find((city) => city.key === key)?.title ?? ''

const normalizeText = (value: string) =>
    value
        .trim()
        .toLowerCase()
        .replace(/[أإآ]/g, 'ا')
        .replace(/ة/g, 'ه')
        .replace(/ى/g, 'ي')
        .replace(/[ؤئ]/g, 'ء')
        .replace(/[٠-٩]/g, (digit) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)))

const resolveEnvKey = (primary: string, ...fallbacks: string[]) => {
    if (process.env[primary]?.trim()) return primary

    for (const key of fallbacks) {
        if (process.env[key]?.trim()) return key
    }

    return null
}

const logMetaEnv = () => {
    console.log('[META_ENV]', {
        tokenPresent: Boolean(META_WHATSAPP_TOKEN),
        tokenLength: META_WHATSAPP_TOKEN?.length ?? 0,
        tokenSource: resolveEnvKey('META_WHATSAPP_TOKEN', 'META_WHATSAPP_ACCESS_TOKEN'),
        phoneNumberId: META_WHATSAPP_PHONE_NUMBER_ID ?? null,
        phoneSource: resolveEnvKey(
            'META_WHATSAPP_PHONE_NUMBER_ID',
            'META_PHONE_NUMBER_ID'
        ),
        verifyPresent: Boolean(META_WHATSAPP_VERIFY_TOKEN),
        verifyLength: META_WHATSAPP_VERIFY_TOKEN?.length ?? 0,
        verifySource: resolveEnvKey(
            'META_WHATSAPP_VERIFY_TOKEN',
            'META_VERIFY_TOKEN'
        ),
    })
}

const logGraphError = (label: string, status: number, data: any) => {
    console.error(label, {
        status,
        code: data?.error?.code ?? null,
        type: data?.error?.type ?? null,
        message: data?.error?.message ?? null,
        fbtrace_id: data?.error?.fbtrace_id ?? null,
    })
}

const sessions = new Map<string, BotSession>()

const requireMetaConfig = () => {
    if (!META_WHATSAPP_VERIFY_TOKEN) {
        throw new Error(
            'META_WHATSAPP_VERIFY_TOKEN is missing in .env (fallback: META_VERIFY_TOKEN)'
        )
    }

    if (!META_WHATSAPP_TOKEN) {
        throw new Error(
            'META_WHATSAPP_TOKEN is missing in .env (fallback: META_WHATSAPP_ACCESS_TOKEN)'
        )
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

const sendMetaPayload = async (to: string, payload: Record<string, unknown>) => {
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
                ...payload,
            }),
        }
    )

    const data = await response.json()

    if (!response.ok) {
        logGraphError('[META_SEND_ERROR]', response.status, data)

        if (data?.error?.code === 190) {
            console.error(
                '[META_SEND_ERROR]',
                'Authentication Error (190): token expired, wrong app, missing WhatsApp permissions, or recipient not in test list for Development mode.'
            )
        }

        throw new Error(
            `Failed to send WhatsApp message: ${data?.error?.message ?? response.status}`
        )
    }

    console.log('[META_SEND_OK]', {
        status: response.status,
        to,
        messageId: data?.messages?.[0]?.id ?? null,
    })

    return data
}

const sendMetaText = async (to: string, body: string) => {
    console.log('[META_SEND_TEXT]', { to, bodyLength: body.length })

    return sendMetaPayload(to, {
        type: 'text',
        text: {
            body,
        },
    })
}

const sendMetaList = async (
    to: string,
    body: string,
    buttonText: string,
    sectionTitle: string,
    rows: ListRow[]
) => {
    console.log('[META_SEND_LIST]', {
        to,
        bodyLength: body.length,
        rows: rows.length,
    })

    return sendMetaPayload(to, {
        type: 'interactive',
        interactive: {
            type: 'list',
            body: {
                text: body,
            },
            action: {
                button: buttonText,
                sections: [
                    {
                        title: sectionTitle,
                        rows,
                    },
                ],
            },
        },
    })
}

const sendCityList = async (to: string, kind: 'pickup' | 'dropoff') => {
    await sendMetaList(
        to,
        kind === 'pickup'
            ? 'اختر مدينة الاستلام من القائمة:'
            : 'اختر مدينة التسليم من القائمة:',
        'اختيار المدينة',
        'المدن',
        cities.map((city) => ({
            id: `${kind}_city:${city.key}`,
            title: city.title,
            description: city.description,
        }))
    )
}

const sendAreaList = async (
    to: string,
    kind: 'pickup' | 'dropoff',
    cityKey: CityKey
) => {
    await sendMetaList(
        to,
        kind === 'pickup'
            ? `اختر منطقة الاستلام داخل ${cityTitle(cityKey)}:`
            : `اختر منطقة التسليم داخل ${cityTitle(cityKey)}:`,
        'اختيار المنطقة',
        'المناطق',
        areasByCity[cityKey].map((area, index) => ({
            id: `${kind}_area:${cityKey}:${index}`,
            title: area,
        }))
    )
}

const parseCity = (incoming: string, kind: 'pickup' | 'dropoff') => {
    const normalized = normalizeText(incoming)

    const byId = incoming.match(new RegExp(`^${kind}_city:(.+)$`))
    if (byId) {
        const key = byId[1] as CityKey
        if (cities.some((city) => city.key === key)) return key
    }

    const byNumber = Number(normalized)
    if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= cities.length) {
        return cities[byNumber - 1].key
    }

    return cities.find((city) => normalizeText(city.title) === normalized)?.key ?? null
}

const parseArea = (
    incoming: string,
    kind: 'pickup' | 'dropoff',
    cityKey: CityKey
) => {
    const byId = incoming.match(new RegExp(`^${kind}_area:${cityKey}:(\\d+)$`))
    if (byId) {
        const index = Number(byId[1])
        return areasByCity[cityKey][index] ?? null
    }

    const normalized = normalizeText(incoming)
    const byNumber = Number(normalized)

    if (
        Number.isInteger(byNumber) &&
        byNumber >= 1 &&
        byNumber <= areasByCity[cityKey].length
    ) {
        return areasByCity[cityKey][byNumber - 1]
    }

    return (
        areasByCity[cityKey].find((area) => normalizeText(area) === normalized) ??
        null
    )
}

const buildSummary = (session: BotSession) => {
    return [
        'ملخص الطلب:',
        '',
        `الاستلام: ${cityTitle(session.pickupCity)} - ${session.pickupArea}`,
        `التسليم: ${cityTitle(session.dropoffCity)} - ${session.dropoffArea}`,
        `تفاصيل الطلب: ${session.details}`,
        '',
        'للتأكيد اكتب: تأكيد',
        'للإلغاء اكتب: إلغاء',
    ].join('\n')
}

const validateMetaCredentials = async () => {
    try {
        const { token, phoneNumberId } = requireMetaConfig()

        const hasAccessTokenWord = token.toLowerCase().includes('access token')
        const hasNewline = /[\r\n]/.test(token)

        console.log('[META_AUTH_CHECK]', {
            tokenPresent: true,
            tokenLength: token.length,
            phoneNumberId,
            hasAccessTokenWord,
            hasNewline,
        })

        if (hasAccessTokenWord || hasNewline) {
            console.error(
                '[META_AUTH_CHECK]',
                'Invalid token format in .env — use the token value only, one line, no label text.'
            )
        }

        const meResponse = await fetch(
            `https://graph.facebook.com/${META_API_VERSION}/me`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            }
        )
        const meData = await meResponse.json()

        if (!meResponse.ok) {
            logGraphError('[META_AUTH_CHECK_ME]', meResponse.status, meData)
        } else {
            console.log('[META_AUTH_CHECK_ME]', {
                status: meResponse.status,
                ok: true,
                name: meData.name ?? null,
            })
        }

        const phoneResponse = await fetch(
            `https://graph.facebook.com/${META_API_VERSION}/${phoneNumberId}?fields=display_phone_number,verified_name`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            }
        )
        const phoneData = await phoneResponse.json()

        if (!phoneResponse.ok) {
            logGraphError('[META_AUTH_CHECK_PHONE]', phoneResponse.status, phoneData)
        } else {
            console.log('[META_AUTH_CHECK_PHONE]', {
                status: phoneResponse.status,
                ok: true,
                verifiedName: phoneData.verified_name ?? null,
                displayPhoneNumber: phoneData.display_phone_number ?? null,
            })
        }
    } catch (error) {
        console.error('[META_AUTH_CHECK_FAILED]', error)
    }
}

const handleIncoming = async (from: string, textOrButtonId: string) => {
    const incoming = textOrButtonId.trim()
    const normalized = normalizeText(incoming)
    const session = sessions.get(from) ?? null

    console.log('[META_INCOMING]', {
        from,
        step: session?.step ?? 'NEW',
        incoming,
    })

    if (['الغاء', 'الغى', 'الغاء الطلب', 'cancel'].includes(normalized)) {
        sessions.delete(from)
        await sendMetaText(from, 'تم إلغاء الطلب. أرسل أي رسالة للبدء من جديد.')
        return
    }

    if (!session) {
        sessions.set(from, { step: 'PICKUP_CITY' })
        await sendMetaText(from, 'مرحبا بك في خدمة التوصيل.')
        await sendCityList(from, 'pickup')
        return
    }

    if (session.step === 'PICKUP_CITY') {
        const cityKey = parseCity(incoming, 'pickup')

        if (!cityKey) {
            await sendMetaText(from, 'لم أفهم المدينة. اخترها من القائمة.')
            await sendCityList(from, 'pickup')
            return
        }

        const nextSession: BotSession = {
            ...session,
            step: 'PICKUP_AREA',
            pickupCity: cityKey,
        }

        sessions.set(from, nextSession)
        await sendAreaList(from, 'pickup', cityKey)
        return
    }

    if (session.step === 'PICKUP_AREA') {
        if (!session.pickupCity) {
            sessions.set(from, { step: 'PICKUP_CITY' })
            await sendCityList(from, 'pickup')
            return
        }

        const area = parseArea(incoming, 'pickup', session.pickupCity)

        if (!area) {
            await sendMetaText(from, 'لم أفهم منطقة الاستلام. اخترها من القائمة.')
            await sendAreaList(from, 'pickup', session.pickupCity)
            return
        }

        const nextSession: BotSession = {
            ...session,
            step: 'DROPOFF_CITY',
            pickupArea: area,
        }

        sessions.set(from, nextSession)
        await sendCityList(from, 'dropoff')
        return
    }

    if (session.step === 'DROPOFF_CITY') {
        const cityKey = parseCity(incoming, 'dropoff')

        if (!cityKey) {
            await sendMetaText(from, 'لم أفهم مدينة التسليم. اخترها من القائمة.')
            await sendCityList(from, 'dropoff')
            return
        }

        const nextSession: BotSession = {
            ...session,
            step: 'DROPOFF_AREA',
            dropoffCity: cityKey,
        }

        sessions.set(from, nextSession)
        await sendAreaList(from, 'dropoff', cityKey)
        return
    }

    if (session.step === 'DROPOFF_AREA') {
        if (!session.dropoffCity) {
            sessions.set(from, { ...session, step: 'DROPOFF_CITY' })
            await sendCityList(from, 'dropoff')
            return
        }

        const area = parseArea(incoming, 'dropoff', session.dropoffCity)

        if (!area) {
            await sendMetaText(from, 'لم أفهم منطقة التسليم. اخترها من القائمة.')
            await sendAreaList(from, 'dropoff', session.dropoffCity)
            return
        }

        const nextSession: BotSession = {
            ...session,
            step: 'DETAILS',
            dropoffArea: area,
        }

        sessions.set(from, nextSession)
        await sendMetaText(from, 'اكتب تفاصيل الطلب: مثال: كيس صغير، أكل، أغراض، رقم الطلب أو أي ملاحظة.')
        return
    }

    if (session.step === 'DETAILS') {
        const details = incoming

        if (details.length < 2) {
            await sendMetaText(from, 'اكتب تفاصيل الطلب بشكل أوضح.')
            return
        }

        const nextSession: BotSession = {
            ...session,
            step: 'CONFIRM',
            details,
        }

        sessions.set(from, nextSession)
        await sendMetaText(from, buildSummary(nextSession))
        return
    }

    if (session.step === 'CONFIRM') {
        const confirmed = ['تاكيد', 'اكد', 'نعم', 'تمام', 'موافق', 'confirm'].includes(
            normalized
        )

        if (!confirmed) {
            await sendMetaText(from, 'لإنشاء الطلب اكتب: تأكيد\nأو اكتب: إلغاء')
            return
        }

        console.log('[META_ORDER_COMPLETED]', {
            from,
            pickupCity: cityTitle(session.pickupCity),
            pickupArea: session.pickupArea,
            dropoffCity: cityTitle(session.dropoffCity),
            dropoffArea: session.dropoffArea,
            details: session.details,
        })

        sessions.delete(from)

        await sendMetaText(
            from,
            'تم تأكيد الطلب بنجاح. سيتم متابعة الطلب من قبل فريق التوصيل.'
        )
    }
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
        const listReplyId = message.interactive?.list_reply?.id
        const buttonReplyId = message.interactive?.button_reply?.id

        if (listReplyId || buttonReplyId) {
            return {
                from,
                textOrButtonId: String(listReplyId ?? buttonReplyId),
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
        verifyTokenMatch: token === META_WHATSAPP_VERIFY_TOKEN,
        expectedLength: META_WHATSAPP_VERIFY_TOKEN?.length ?? 0,
        receivedLength: typeof token === 'string' ? token.length : 0,
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

const server = app.listen(PORT, async () => {
    console.log(`[META_BOT_READY] http://localhost:${PORT}`)
    console.log(`[META_WEBHOOK] GET/POST /webhook/meta`)
    console.warn(
        '[META_CITY_AREA_FLOW]',
        'This server uses interactive city -> area WhatsApp list flow.'
    )
    logMetaEnv()
    await validateMetaCredentials()
})

server.on('error', (error) => {
    console.error('[META_SERVER_ERROR]', error)
})

process.stdin.resume()
