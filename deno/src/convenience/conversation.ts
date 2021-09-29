import { InlineKeyboard } from './keyboard.ts'
import { Context } from '../context.ts'
import {
    Composer,
    Middleware,
    MiddlewareFn,
    MiddlewareObj,
} from '../composer.ts'
import { SessionFlavor, session } from './session.ts'
import { Bot } from '../bot.ts'
import { Filter, FilterQuery } from '../filter.ts'

////////////////////////////////////////////////////
/////                   IMPL                   /////
////////////////////////////////////////////////////

type MyContext = Context &
    ConversationFlavor &
    SessionFlavor<{ month?: string; day?: number }>

export interface ConversationFlavor {
    session?: {
        conversation?: { active: string; step: string | number }
    }
    conversation: {
        enter: (identifier: string, step?: string) => Promise<void>
        leave: () => Promise<void>
        back: (steps?: number) => Promise<void>
        forward: (steps?: number) => Promise<void>
        diveOut: (depth?: number) => Promise<void>
        switch: (identifier: string) => Promise<void>
    }
}

type Id = string | number
type ConversationContext = Context & ConversationFlavor & SessionFlavor<object>

const internal = Symbol()
type Internal = typeof internal

export class Conversation<C extends ConversationContext>
    implements MiddlewareObj<C>
{
    private identifier: Id | undefined = undefined

    private mw: Composer<C> | undefined = undefined
    private head: Conversation<C> | null = null
    private tail: Conversation<C> | null = null

    private parent: Conversation<C> | null = null
    private prev: Conversation<C> | null = null
    private next: Conversation<C> | null = null

    private index: Map<Id, Conversation<C>> = new Map()

    constructor(identifier: string | Internal) {
        if (identifier !== internal) this.id = identifier
    }

    public get id(): string {
        if (typeof this.identifier === 'string') return this.identifier
        else throw new Error('Anonymous conversations do not have identifiers')
    }
    private set id(id: Id) {
        if (this.identifier !== undefined)
            throw new Error(
                `Cannot change existing conversation identifier '${this.identifier}'!`
            )
        this.identifier = id
        this.index.set(this.id, this)
    }

    public get domain(): Conversation<C> {
        const conv = this.index.values().next().value
        if (conv === undefined) throw new Error(`Unknown domain!`)
        return conv
    }

    private add(node: Conversation<C>) {
        if (this.tail === null)
            throw new Error('Cannot call `wait` without any middleware!')
        node.prev = this.tail
        node.parent = this
        node.index = this.index
        this.tail.next = node
        this.tail = node
    }

    wait(id?: string) {
        id ??= this.index.size as unknown as string // permit `number` only internally
        const node = new Conversation<C>(id)
        this.add(node)
        return node
    }

    diveIn(id?: string) {
        this.id = id ?? this.index.size
        return this
    }

    private wrapComposer<D extends C>(op: (comp: Composer<C>) => Composer<D>) {
        if (this.head === null || this.tail === null) {
            this.head = this.tail = new Conversation(internal)
            this.head.parent = this.tail.parent = this
        }
        this.tail.mw ??= new Composer()
        const node = new Conversation<D>(internal)
        node.mw = op(this.tail.mw)
        return node
    }

    use(...middleware: Array<Middleware<C>>): Conversation<C> {
        return this.wrapComposer(c => c.use(...middleware))
    }

    filter(pred: (ctx: C) => boolean, ...middleware: Array<Middleware<C>>) {
        return this.wrapComposer(c => c.filter(pred, ...middleware))
    }

    on<Q extends FilterQuery>(
        filter: Q | Q[],
        ...middleware: Array<Middleware<Filter<C, Q>>>
    ): Conversation<Filter<C, Q>> {
        return this.wrapComposer(c => c.on(filter, ...middleware))
    }
    hears(h: string, ...middleware: Array<Middleware<C>>) {
        return this.wrapComposer(c => c.hears(h, ...middleware))
    }
    command(h: string, ...middleware: Array<Middleware<C>>) {
        return this.wrapComposer(c => c.command(h, ...middleware))
    }
    callbackQuery(h: string, ...middleware: Array<Middleware<C>>) {
        return this.wrapComposer(c => c.callbackQuery(h, ...middleware))
    }

    middleware(): MiddlewareFn<C> {
        return (ctx, next) => {
            const session = ctx.session
            const conversation = session.conversation
            if (conversation === undefined) return next()
            const { active, step } = conversation
            const domain = this.domain
            if (active !== domain.id) return next()
            let target: Conversation<C>
            if (step === 0) {
                const t = domain.head
                if (t === null)
                    throw new Error(
                        `Cannot enter '${active}' because it is empty`
                    )
                target = t
            } else {
                const t = this.index.get(step)
                if (t === undefined)
                    throw new Error(
                        `Cannot find '${step}' under '${domain.id}'`
                    )
                if (t.id !== step) throw new Error('Index out of sync')
                target = t
            }
            if (target.mw === undefined)
                throw new Error(
                    `Selected step '${target.id}' has no middleware`
                )
            ctx.conversation = {
                // enter: (identifier: string) => Promise<void>
                enter: (identifier, step) => {
                    session.conversation = {
                        active: identifier,
                        step: step ?? 0,
                    }
                    return Promise.resolve()
                },
                // leave: () => Promise<void>
                leave: () => {
                    delete session.conversation
                    return Promise.resolve()
                },
                // back: (steps?: number) => Promise<void>
                back: (steps = 1) => {
                    for (
                        let node: Conversation<C> = this;
                        steps > 0;
                        steps--, node = node.prev
                    ) {
                        if (node.prev === null)
                            throw new Error(
                                `Reached beginning, cannot go another ${steps} steps back!`
                            )
                    }
                    conversation.step = node.id
                    return Promise.resolve()
                },
                // forward: (steps?: number) => Promise<void>
                forward: (steps = 1) => {
                    for (
                        let node: Conversation<C> = this;
                        steps > 0;
                        steps--, node = node.next
                    ) {
                        if (node.next === null)
                            throw new Error(
                                `Reached end, cannot go another ${steps} steps forward!`
                            )
                    }
                    conversation.step = node.id
                    return Promise.resolve()
                },
                // diveOut: (depth?: number) => Promise<void>
                diveOut: (depth = 1) => {
                    for (
                        let node: Conversation<C> = this;
                        depth > 0;
                        depth--, node = node.parent
                    ) {
                        if (node.parent === null)
                            throw new Error(
                                `Reached top, cannot dive out another ${depth} times!`
                            )
                    }
                    conversation.step = node.id
                    return Promise.resolve()
                },
                // switch: (identifier: string) => Promise<void>
                switch: identifier => {
                    if (!this.index.has(identifier)) {
                        throw new Error(
                            `Step '${identifier}' is unknown. Did you mean to enter a different conversation?`
                        )
                    }
                    conversation.step = identifier
                    return Promise.resolve()
                },
            }
            return target.mw.middleware()(ctx, next)
            // TODO: install navigation functions
        }
    }
}

////////////////////////////////////////////////////
/////                EXAMPLES                  /////
////////////////////////////////////////////////////

// (1)

// Confer https://grammy.dev/plugins/router.html#combining-routers-with-sessions

const conv = new Conversation<MyContext>('birthday-calc')

conv.command('start', ctx => ctx.reply('Send me the month of your birthday!'))
conv.on('message', ctx =>
    ctx.reply('Use one of the commands or send /help for instrutions.')
)

conv.wait()

conv.on(':text', async ctx => {
    const txt = ctx.msg?.text ?? ''
    if (months.includes(txt)) {
        ctx.session.month = txt
        await ctx.reply('Thanks, saved the month. Now, send me the day')
        await ctx.conversation.forward()
    } else {
        await ctx.reply('Not a month! Use one of: ' + months.join(', '))
    }
})
conv.on('message', async ctx => {
    await ctx.reply('Please send me the month as text!')
})

conv.wait()

conv.on(':text', async ctx => {
    const day = parseInt(ctx.msg?.text ?? '', 10)
    if (isNaN(day) || day < 1 || 31 < day) {
        await ctx.reply('That is not a valid day, try again!')
        return
    }

    ctx.session.day = day
})
conv.on('message', async ctx => {
    await ctx.reply('Please send me the day as text!')
})

const bot = new Bot<MyContext>('')

bot.use(session(), conv)

bot.command('start', ctx => {
    ctx.conversation.switch('birthday-calc')
})

const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
]

// (2)

// Flat list vs. structure, both have same external behaviour

const root = new Conversation<MyContext>('')

root.on('message', ctx => ctx.conversation.forward())
    .wait()
    .on('message', ctx => ctx.conversation.forward())
    .wait()
    .on('message', ctx => ctx.conversation.forward())

// Root
// -- message
//    -- message
//       -- message

root.on('message', ctx => ctx.conversation.forward())
root.wait()
root.on('message', ctx => ctx.conversation.forward())
root.wait()
root.on('message', ctx => ctx.conversation.forward())

// Root
// -- message
// -- message
// -- message

// (3)

// Superfluous wait calls, how to avoid?

const c = new Conversation<MyContext>('')

const buttonClick = c.command('start', async ctx => {
    await ctx.reply('Welcome!')
    await ctx.reply('What do you want to do?', {
        reply_markup: new InlineKeyboard().text('left').text('right'),
    })
})

buttonClick.wait()

const left = buttonClick
    .callbackQuery('left', ctx => ctx.reply('Go left!'))
    .diveIn()

const right = buttonClick
    .callbackQuery('right', ctx => ctx.reply('Go right!'))
    .diveIn()

c.on('message', ctx => ctx.reply('Send /start!'))

// (4)

// Example of binary tree walk in conversation

const cllr = new Conversation<MyContext>('llr-walk')

// root
const l = cllr.hears('L', ctx => ctx.reply('1st choice is L')).diveIn()
const r = cllr.hears('R', ctx => ctx.reply('1st choice is R')).diveIn()
cllr.on('message', ctx => ctx.reply('Please send L or R as 1st choice!'))

// L
const ll = l.hears('L', ctx => ctx.reply('2nd choice after L is L')).diveIn()
const lr = l.hears('R', ctx => ctx.reply('2nd choice after L is R')).diveIn()
l.on('message', ctx => ctx.reply('Please send L or R as 2nd choice after L!'))

// R
const rl = r.hears('L', ctx => ctx.reply('2nd choice after R is L')).diveIn()
const rr = r.hears('R', ctx => ctx.reply('2nd choice after R is R')).diveIn()
r.on('message', ctx => ctx.reply('Please send L or R as 2nd choice after R!'))

// LL
const lll = ll.hears('L', ctx => ctx.reply('3rd choice after LL is L')).diveIn()
const llr = ll.hears('R', ctx => ctx.reply('3rd choice after LL is R')).diveIn()
ll.on('message', ctx => ctx.reply('Please send L or R as 3rd choice after LL!'))

// LR
const lrl = lr.hears('L', ctx => ctx.reply('3rd choice after LR is L')).diveIn()
const lrr = lr.hears('R', ctx => ctx.reply('3rd choice after LR is R')).diveIn()
lr.on('message', ctx => ctx.reply('Please send L or R as 3rd choice after LR!'))

// RL
const rll = rl.hears('L', ctx => ctx.reply('3rd choice after LL is L')).diveIn()
const rlr = rl.hears('R', ctx => ctx.reply('3rd choice after LL is R')).diveIn()
rl.on('message', ctx => ctx.reply('Please send L or R as 3rd choice after LL!'))

// RR
const rrl = rr.hears('L', ctx => ctx.reply('3rd choice after LR is L')).diveIn()
const rrr = rr.hears('R', ctx => ctx.reply('3rd choice after LR is R')).diveIn()
rr.on('message', ctx => ctx.reply('Please send L or R as 3rd choice after LR!'))

// Exit
for (const c of [lll, llr, lrl, lrr, rll, rlr, rrl, rrr]) {
    c.on('message', (ctx, next) => {
        ctx.conversation.diveOut(3)
        // equivalent:
        // ctx.conversation.switch('llr-walk')
        return next()
    })
}

lll.on('message', ctx => ctx.reply('You walked LLL. Restarting!'))
llr.on('message', ctx => ctx.reply('You walked LLR. Restarting!'))
lrl.on('message', ctx => ctx.reply('You walked LRL. Restarting!'))
lrr.on('message', ctx => ctx.reply('You walked LRR. Restarting!'))
rll.on('message', ctx => ctx.reply('You walked RLL. Restarting!'))
rlr.on('message', ctx => ctx.reply('You walked RLR. Restarting!'))
rrl.on('message', ctx => ctx.reply('You walked RRL. Restarting!'))
rrr.on('message', ctx => ctx.reply('You walked RRR. Restarting!'))

////////////////////////////////////////////////////
/////              DESIGN NOTES                /////
////////////////////////////////////////////////////

// - every conversation has an optional identifier that defaults to map.size
// - every conversation has one composer
// - every conversation has a reference to
//   - its parent,
//   - its predecessor,
//   - its successor, and
//   - its linked list of child conversations
// - every conversation shares a tree-global map of identifier -> conversation, i.e. the flattened out tree structure
// - navigation is performed by traversing the tree structure
// - update handling is performed by O(1) lookup of the right conversation, and running the composer
// - composer-methods are creating a new conversation with identical nodes and changed composer
// - conversation-methods are creating a new conversation with changed nodes and identical composer
