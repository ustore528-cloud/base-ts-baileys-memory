import 'dotenv/config'
import express from 'express'
import {
    type AreasSession,
    handleAreasMessage,
    normalizeText,
} from './areas-flow'

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
        tokenSource: resolveEnvKey('META_WHATSAPP_TOKEN'),
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

const sessions = new Map<string, AreasSession>()

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

    console.log('[META_SEND_TEXT]', {
        to,
        phoneNumberId,
        tokenPresent: true,
        tokenLength: token.length,
        bodyLength: body.length,
    })

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
        logGraphError('[META_SEND_TEXT_ERROR]', response.status, data)

        if (data?.error?.code === 190) {
            console.error(
                '[META_SEND_TEXT_ERROR]',
                'Authentication Error (190): token expired, wrong app, missing WhatsApp permissions, or recipient not in test list for Development mode.'
            )
        }

        throw new Error(
            `Failed to send text message: ${data?.error?.message ?? response.status}`
        )
    }

    console.log('[META_SEND_TEXT_OK]', {
        status: response.status,
        to,
        messageId: data?.messages?.[0]?.id ?? null,
    })

    return data
}

const handleIncoming = async (from: string, textOrButtonId: string) => {
    const incoming = textOrButtonId.trim()
    const session = sessions.get(from) ?? null

    console.log('[META_INCOMING]', {
        from,
        step: session?.step ?? 'NEW',
        incoming,
    })

    if (normalizeText(incoming) === 'الغاء' || normalizeText(incoming) === 'الغى') {
        sessions.delete(from)
        await sendMetaText(from, 'تم إلغاء الطلب. أرسل أي رسالة للبدء من جديد.')
        return
    }

    const result = handleAreasMessage(incoming, session)

    if (result.session) {
        sessions.set(from, result.session)
    } else {
        sessions.delete(from)
    }

    for (const message of result.messages) {
        await sendMetaText(from, message)
    }

    if (result.completed) {
        console.log('[META_ORDER_COMPLETED]', { from })
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
    logMetaEnv()
    await validateMetaCredentials()
})

server.on('error', (error) => {
    console.error('[META_SERVER_ERROR]', error)
})

process.stdin.resume()
