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
