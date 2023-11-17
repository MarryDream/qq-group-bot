import {MessageElem, Quotable, Sendable} from "@/elements";
import {QQBot} from "@/qqBot";
import {Dict} from "@/types";
import {trimQuote} from "@/utils";
import {randomInt} from "crypto";
import {Bot} from "./bot";
import {User} from "@/entries/user";

export class Message {
    message_type: Message.SubType

    get self_id() {
        return this.bot.self_id
    }

    guild_id?: string
    channel_id?: string
    group_id?: string
    message_id: string
    sender: Message.Sender
    user_id: string

    constructor(public bot: Bot, attrs: Partial<Message>) {
        Object.assign(this, attrs)
    }

    raw_message: string
    message_reference?: { message_id: string }
    message: Sendable


    get [Symbol.unscopables]() {
        return {
            bot: true
        }
    }


    toJSON() {
        return Object.fromEntries(Object.keys(this)
            .filter(key => {
                return typeof this[key] !== "function" && !(this[key] instanceof QQBot)
            })
            .map(key => [key, this[key]])
        )
    }
}


export interface MessageEvent {
    reply(message: Sendable, quote?: boolean): Promise<any>
}

export class PrivateMessageEvent extends Message implements MessageEvent {
    constructor(bot: Bot, payload: Partial<Message>) {
        super(bot, payload);
        this.message_type = 'private'
    }

    async reply(message: Sendable) {
        return this.bot.sendPrivateMessage(this.user_id, message, this)
    }
}

export class GroupMessageEvent extends Message implements MessageEvent {
    group_id: string
    group_name: string

    constructor(bot: Bot, payload: Partial<Message>) {
        super(bot, payload);
        this.message_type = 'group'
    }

    async reply(message: Sendable) {
        return this.bot.sendGroupMessage(this.group_id, message, this)
    }
}

export class DirectMessageEvent extends Message implements MessageEvent {
    user_id: string
    channel_id: string

    constructor(bot: Bot, payload: Partial<Message>) {
        super(bot, payload);
        this.message_type = 'direct'
    }

    reply(message: Sendable) {
        return this.bot.sendDirectMessage(this.guild_id, message, this)
    }
}

export class GuildMessageEvent extends Message implements MessageEvent {
    guild_id: string
    guild_name: string
    channel_id: string

    channel_name: string

    constructor(bot: Bot, payload: Partial<Message>) {
        super(bot, payload);
        this.message_type = 'guild'
    }

    async asAnnounce() {
        return this.bot.setChannelAnnounce(this.guild_id, this.channel_id, this.message_id)
    }

    async pin() {
        return this.bot.pinChannelMessage(this.channel_id, this.message_id)
    }

    async reply(message: Sendable) {
        return this.bot.sendGuildMessage(this.channel_id, message, this)
    }
}

export namespace Message {
    export interface Sender {
        user_id: string
        user_name: string
        permissions: User.Permission[]
    }

    export type SubType = 'private' | 'group' | 'guild' | 'direct'

    export function parse(this: QQBot, payload: Dict) {
        let template = payload.content || ''
        let result: MessageElem[] = []
        let brief: string = ''
        // 1. 处理文字表情混排
        const regex = /("[^"]*?"|'[^']*?'|`[^`]*?`|“[^”]*?”|‘[^’]*?’|<[^>]+?>)/;
        while (template.length) {
            const [match] = template.match(regex) || [];
            if (!match) break;
            const index = template.indexOf(match);
            const prevText = template.slice(0, index);
            if (prevText) {
                result.push({
                    type: 'text',
                    text: prevText
                })
                brief += prevText
            }
            template = template.slice(index + match.length);
            if (match.startsWith('<')) {
                let [type, ...attrs] = match.slice(1, -1).split(',');
                if (type.startsWith('faceType')) {
                    type = 'face'
                    attrs = attrs.map((attr: string) => attr.replace('faceId', 'id'))
                } else if (type.startsWith('@')) {
                    if (type.startsWith('@!')) {
                        const id = type.slice(2,)
                        type = 'at'
                        attrs = Object.entries(payload.mentions.find((u: Dict) => u.id === id) || {})
                            .map(([key, value]) => `${key}=${value}`)
                    } else if (type === '@everyone') {
                        type = 'at'
                        attrs = [['all', true]]
                    }
                } else if (/^[a-z]+:[0-9]+$/.test(type)) {
                    attrs = ['id=' + type.split(':')[1]]
                    type = 'face'
                }
                result.push({
                    type,
                    ...Object.fromEntries(attrs.map((attr: string) => {
                        const [key, ...values] = attr.split('=')
                        return [key.toLowerCase(), trimQuote(values.join('='))]
                    }))
                })
                brief += `<${type}:${attrs.join(',')}>`
            } else {
                result.push({
                    type: "text",
                    data: {
                        text: match
                    }
                });
                brief += match;
            }
        }
        if (template) {
            result.push({
                type: 'text',
                text: template
            })
            brief += template
        }
        // 2. 将附件添加到消息中
        if (payload.attachments) {
            for (const attachment of payload.attachments) {
                let {content_type, ...data} = attachment
                const [type] = content_type.split('/')
                result.push({
                    type,
                    ...data,
                    src: data.src || data.url,
                    url: data.url || data.src
                })
                brief += `<$${type},${Object.entries(data).map(([key, value]) => `${key}=${value}`).join(',')}>`
            }
        }
        delete payload.attachments
        delete payload.mentions
        return [result, brief]
    }

    const getType = (type: string) => {
        return ['image', 'video', 'audio'].indexOf(type) + 1
    }

    export async function format(this: QQBot, message: Sendable, source: Quotable = {}) {
        let brief: string = ''
        const messages: Dict = {
            msg_type: 0,
            content: '',
            msg_id: source?.message_id,
            msg_seq: randomInt(1, 1000000),
            timestamp: Number((Date.now() / 1000).toFixed(0))
        }
        const files: Dict = {
            msg_id: source?.message_id,
            msg_seq: randomInt(1, 1000000),
            timestamp: Number((Date.now() / 1000).toFixed(0))
        }
        let hasMessages = false, hasFiles = false, buttons = [];
        if (!Array.isArray(message)) message = [message as any]
        for (let elem of message) {
            if (typeof elem === 'string') {
                elem = {
                    type: 'text',
                    text: elem
                }
            }
            switch (elem.type) {
                case 'reply':
                    messages.msg_id = elem.message_id
                    files.msg_id = elem.message_id
                    brief += `<$reply,message_id=${elem.message_id}>`
                    break;
                case "at":
                    if (messages.content) {
                        messages.content += `<@${elem.id || 'everyone'}>`
                    } else {
                        messages.content = `<@${elem.id || 'everyone'}>`
                    }
                    brief += `<$at,user=${elem.id || 'everyone'}>`
                    break;
                case 'link':
                    if (messages.content) {
                        messages.content += `<#${elem.channel_id}>`
                    } else {
                        messages.content = `<#${elem.channel_id}>`
                    }
                    brief += `<$link,channel=${elem.channel_id}>`
                    break;
                case 'text':
                    if (messages.content) {
                        messages.content += elem.text
                    } else {
                        messages.content = elem.text
                    }
                    hasMessages = true
                    brief += elem.text
                    break;
                case 'face':
                    if (messages.content) {
                        messages.content += `<emoji:${elem.id}>`
                    } else {
                        messages.content = `<emoji:${elem.id}>`
                    }
                    brief += `<$face,id=${elem.id}>`
                    hasMessages = true
                    break;
                case 'image':
                case 'audio':
                case 'video':
                    files.file_type = getType(elem.type)
                    files.content = 'file'
                    files.url = elem.file
                    files.event_id = source!.event_id
                    files.msg_id = source?.message_id
                    files.srv_send_msg = true
                    hasFiles = true
                    brief += `<${elem.type},file=${elem.file}>`
                    break;
                case 'markdown':
                    messages.markdown = {
                        content: elem.content
                    }
                    messages.msg_type = 2
                    hasMessages = true
                    brief += `<#markdown,content=${elem.content}>`
                    break;
                case 'button':
                    buttons.push(elem.data)
                    brief += `<$button,data=${JSON.stringify(elem.data)}>`
                    break;
            }
        }
        if (buttons.length) {
            const rows = []
            for (let i = 0; i < buttons.length; i += 4) {
                rows.push(buttons.slice(i, i + 4))
            }
            messages.keyboard = {
                content: {
                    rows: rows.map(row => {
                        return {
                            buttons: row
                        }
                    })
                }
            }
        }
        return {
            messages: messages,
            hasFiles,
            hasMessages,
            brief,
            files
        }
    }
}

