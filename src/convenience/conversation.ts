import { InlineKeyboard, Keyboard } from "./keyboard.ts";
import { Context } from "../context.ts";
import {
    Composer,
    Middleware,
    MiddlewareFn,
    MiddlewareObj,
} from "../composer.ts";
import { session, SessionFlavor } from "./session.ts";
import { Bot } from "../bot.ts";
import { Filter, FilterQuery } from "../filter.ts";

////////////////////////////////////////////////////
/////                   IMPL                   /////
////////////////////////////////////////////////////

type MyContext =
    & Context
    & ConversationFlavor
    & SessionFlavor<{ token?: string; app?: string; desc?: string }>;

export interface ConversationFlavor {
    session?: {
        conversation?: { active: string; step: string | number };
    };
    conversation: {
        enter: (identifier: string, step?: string) => Promise<void>;
        leave: () => Promise<void>;
        back: (steps?: number) => Promise<void>;
        forward: (steps?: number) => Promise<void>;
        diveOut: (depth?: number) => Promise<void>;
        switch: (identifier: string) => Promise<void>;
    };
}

type Id = string | number;
type ConversationContext = Context & ConversationFlavor & SessionFlavor<object>;

const internal = Symbol();
type Internal = typeof internal;

class Step<C extends ConversationContext> {
    [internal]: {
        root: Conversation<C> | undefined;
        mw: Composer<C> | undefined;
    } = { root: undefined, mw: undefined };
}

export class Conversation<C extends ConversationContext> extends Step<C>
    implements MiddlewareObj<C> {
    private identifier: Id | undefined = undefined;

    private step: Step<C> = new Step();

    private head: Conversation<C> | null = null;
    private tail: Conversation<C> | null = null;

    private parent: Conversation<C> | null = null;
    private prev: Conversation<C> | null = null;
    private next: Conversation<C> | null = null;

    private index: Map<Id, Conversation<C>> = new Map();

    private mw: Composer<C> | undefined;

    constructor(identifier: string | Internal) {
        super();
        console.log(identifier, new Error().stack);
        if (identifier !== internal) this.id = identifier;
        this.step[internal].root = this;
    }

    public get id(): string {
        if (typeof this.identifier === "string") return this.identifier;
        else throw new Error("Anonymous conversations do not have identifiers");
    }
    private set id(id: Id) {
        if (this.identifier !== undefined) {
            throw new Error(
                `Cannot change existing conversation identifier '${this.identifier}'!`,
            );
        }
        this.identifier = id;
        this.index.set(id, this);
    }

    public get domain(): Conversation<C> {
        const conv = this.index.values().next().value;
        if (conv === undefined) throw new Error(`Unknown domain!`);
        return conv;
    }

    private add(node: Conversation<C>) {
        if (this.tail === null) {
            throw new Error("Cannot call `wait` without any middleware!");
        }
        node.prev = this.tail;
        node.parent = this;
        node.index = this.index;
        this.tail.next = node;
        this.tail = node;
    }

    wait(id?: string) {
        id ??= this.index.size as unknown as string; // permit `number` only internally
        const node = new Conversation<C>(id);
        this.add(node);
        return node;
    }

    diveIn(id?: string) {
        this.id = id ?? this.index.size;
        console.log(
            this.parent?.identifier,
            "now has a child",
            this.identifier,
        );
        return this;
    }

    private wrapComposer<D extends C>(op: (comp: Composer<C>) => Composer<D>) {
        if (this.head === null || this.tail === null) {
            (this.head = this.tail = new Conversation(internal)).parent = this;
        }
        const dive = this.tail;
        dive.mw ??= new Composer(async (ctx, next) => {
            console.log(
                "Running middleware of",
                dive.identifier,
                "under",
                dive.parent,
            );
            if (dive.identifier !== undefined) {
                await this.changeStep(ctx, dive.identifier);
            }
            await next();
        });
        const node = new Conversation<D>(internal);
        node.mw = op(dive.mw);
        const middlewareRoot = node as unknown as Conversation<C>;
        middlewareRoot.head = this.head;
        middlewareRoot.tail = this.tail;
        middlewareRoot.parent = this;
        middlewareRoot.prev = this.prev;
        middlewareRoot.next = this.next;
        middlewareRoot.index = this.index;
        return node;
    }

    use(...middleware: Array<Middleware<C>>): Conversation<C> {
        return this.wrapComposer((c) => c.use(...middleware));
    }

    filter(pred: (ctx: C) => boolean, ...middleware: Array<Middleware<C>>) {
        return this.wrapComposer((c) => c.filter(pred, ...middleware));
    }

    on<Q extends FilterQuery>(
        filter: Q | Q[],
        ...middleware: Array<Middleware<Filter<C, Q>>>
    ): Conversation<Filter<C, Q>> {
        return this.wrapComposer((c) => c.on(filter, ...middleware));
    }
    hears(h: string | RegExp, ...middleware: Array<Middleware<C>>) {
        return this.wrapComposer((c) => c.hears(h, ...middleware));
    }
    command(h: string, ...middleware: Array<Middleware<C>>) {
        return this.wrapComposer((c) => c.command(h, ...middleware));
    }
    callbackQuery(h: string, ...middleware: Array<Middleware<C>>) {
        return this.wrapComposer((c) => c.callbackQuery(h, ...middleware));
    }

    private changeStep(ctx: C, step: Id) {
        if (ctx.session.conversation === undefined) {
            ctx.session.conversation = { active: this.domain.id, step };
        } else ctx.session.conversation.step = step;
        return Promise.resolve();
    }

    private installNavigation(ctx: C) {
        ctx.conversation = {
            // enter: (identifier: string) => Promise<void>
            enter: (identifier, step) => {
                ctx.session.conversation = {
                    active: identifier,
                    step: step ?? 0,
                };
                return Promise.resolve();
            },
            // leave: () => Promise<void>
            leave: () => {
                delete ctx.session.conversation;
                return Promise.resolve();
            },
            // back: (steps?: number) => Promise<void>
            back: (steps = 1) => {
                let node: Conversation<C> | null = this;
                for (; steps > 0; steps--, node = node.prev) {
                    if (node.prev === null) {
                        throw new Error(
                            `Reached beginning, cannot go another ${steps} steps back!`,
                        );
                    }
                }
                return this.changeStep(ctx, node.id);
            },
            // forward: (steps?: number) => Promise<void>
            forward: (steps = 1) => {
                let node: Conversation<C> | null = this;
                for (; steps > 0; steps--, node = node.next) {
                    if (node.next === null) {
                        throw new Error(
                            `Reached end, cannot go another ${steps} steps forward!`,
                        );
                    }
                }
                return this.changeStep(ctx, node.id);
            },
            // diveOut: (depth?: number) => Promise<void>
            diveOut: (depth = 1) => {
                let node: Conversation<C> | null = this;
                for (; depth > 0; depth--, node = node?.parent) {
                    if (node.parent === null) {
                        throw new Error(
                            `Reached top, cannot dive out another ${depth} times!`,
                        );
                    }
                }
                return this.changeStep(ctx, node.id);
            },
            // switch: (identifier: string) => Promise<void>
            switch: (identifier) => {
                if (!this.index.has(identifier)) {
                    throw new Error(
                        `Step '${identifier}' is unknown. Did you mean to enter a different conversation?`,
                    );
                }
                return this.changeStep(ctx, identifier);
            },
        };
    }

    middleware(): MiddlewareFn<C> {
        return (ctx, next) => {
            if (ctx.conversation === undefined) this.installNavigation(ctx);

            const session = ctx.session;
            const conversation = session.conversation;
            if (conversation === undefined) return next();
            const { active, step } = conversation;
            const domain = this.domain;
            if (active !== domain.id) return next();
            let target: Conversation<C>;
            if (step === 0) {
                const t = domain.head;
                if (t === null) {
                    throw new Error(
                        `Cannot enter '${active}' because it is empty`,
                    );
                }
                target = t;
            } else {
                const t = this.index.get(step);
                if (t === undefined) {
                    throw new Error(
                        `Cannot find '${step}' under '${domain.id}'`,
                    );
                }
                if (t.id !== step) throw new Error("Index out of sync");
                target = t;
            }
            if (target.mw === undefined) {
                throw new Error(
                    `Selected step '${target.id}' has no middleware`,
                );
            }
            return target.mw.middleware()(ctx, next);
        };
    }
}

////////////////////////////////////////////////////
/////                EXAMPLES                  /////
////////////////////////////////////////////////////

// +++ EXAMPLE 1 (id, token, description form) +++

const bot = new Bot<MyContext>("");
bot.use(session());

bot.command("start", (ctx) => ctx.reply("Hi! Send /setup to start"));
bot.command("help", (ctx) => ctx.reply("Imagine fancy help text here"));
bot.command("setup", async (ctx) => {
    ctx.conversation.enter("setup");
    await ctx.reply("Cool, send app name");
});

// create conversation for getting app name, token, and optional description
const c = new Conversation<MyContext>("setup");

// c.onEnter()

c.command("cancel", async (ctx) => {
    await ctx.reply("Hit /setup again to retry");
    ctx.conversation.leave();
});
c.hears(/[a-zA-Z-]+/, async (ctx) => {
    await ctx.reply("gotcha, and token?", {
        reply_markup: new InlineKeyboard().text("Edit", "edit"),
    });
    ctx.session.app = String(ctx.match);
    ctx.conversation.forward();
});
c.use((ctx) => ctx.reply("u wot m8"));

// c.onLeave()

c.wait();

c.command("cancel", async (ctx) => {
    ctx.session.app = undefined;
    await ctx.reply("Alright, taking you outta here");
    ctx.conversation.leave();
});
c.callbackQuery("edit", async (ctx) => {
    await ctx.reply("Sure, what is the new app?");
    ctx.conversation.back();
});

const tokenHandler = c.hears(/^[0-9]:[a-zA-Z-_]+$/);
tokenHandler.filter((ctx) => validateToken(ctx.match), async (ctx) => {
    ctx.session.token = String(ctx.match);
    await ctx.reply("Works! Description?", {
        reply_markup: new InlineKeyboard().text("Skip", "skip"),
    });
    ctx.conversation.forward();
});
tokenHandler.use((ctx) => ctx.reply("Token invalid!"));
c.use((ctx) => ctx.reply("Not a token!"));

c.wait();

c.callbackQuery("skip", async (ctx) => {
    ctx.conversation.leave();
    await ctx.reply("Skipped, you are done!");
});
c.on(":text", async (ctx) => {
    ctx.session.desc = ctx.msg.text;
    await ctx.reply("Everything set up!");
    ctx.conversation.leave();
});

bot.use(c);
bot.start();

// +++ EXAMPLE 2 (LLR walk) +++

const bot2 = new Bot<MyContext>("");
bot2.use(session());

bot2.command("start", async (ctx) => {
    await ctx.reply("Choose thrice.", {
        reply_markup: new Keyboard().text("l").text("r"),
    });
    ctx.conversation.enter("llr-walk");
});

const cllr = new Conversation<MyContext>("llr-walk");

// root
const l = cllr.hears("l", (ctx) => ctx.reply("1st choice is L"))
    .diveIn();
const r = cllr.hears("r", (ctx) => ctx.reply("1st choice is R"))
    .diveIn();
cllr.on("message", (ctx) => ctx.reply("Send L or R as 1st choice!"));

// // L
const ll = l.hears("l", (ctx) => ctx.reply("2nd choice after L is L"))
    .diveIn();
const lr = l.hears("r", (ctx) => ctx.reply("2nd choice after L is R"))
    .diveIn();
l.on("message", (ctx) => ctx.reply("Send L or R as 2nd choice after L!"));

// R
const rl = r.hears("l", (ctx) => ctx.reply("2nd choice after R is L"))
    .diveIn();
const rr = r.hears("r", (ctx) => ctx.reply("2nd choice after R is R"))
    .diveIn();
r.on("message", (ctx) => ctx.reply("Send L or R as 2nd choice after R!"));

// LL
const lll = ll.hears("l", (ctx) => ctx.reply("3rd choice after LL is L"))
    .diveIn();
const llr = ll.hears("r", (ctx) => ctx.reply("3rd choice after LL is R"))
    .diveIn();
ll.on("message", (ctx) => ctx.reply("Send L or R as 3rd choice after LL!"));

// LR
const lrl = lr.hears("l", (ctx) => ctx.reply("3rd choice after LR is L"))
    .diveIn();
const lrr = lr.hears("r", (ctx) => ctx.reply("3rd choice after LR is R"))
    .diveIn();
lr.on("message", (ctx) => ctx.reply("Send L or R as 3rd choice after LR!"));

// RL
const rll = rl.hears("l", (ctx) => ctx.reply("3rd choice after RL is L"))
    .diveIn();
const rlr = rl.hears("r", (ctx) => ctx.reply("3rd choice after RL is R"))
    .diveIn();
rl.on("message", (ctx) => ctx.reply("Send L or R as 3rd choice after LL!"));

// RR
const rrl = rr.hears("l", (ctx) => ctx.reply("3rd choice after RR is L"))
    .diveIn();
const rrr = rr.hears("r", (ctx) => ctx.reply("3rd choice after RR is R"))
    .diveIn();
rr.on("message", (ctx) => ctx.reply("Send L or R as 3rd choice after LR!"));

// Exit on next message
for (const c of [lll, llr, lrl, lrr, rll, rlr, rrl, rrr]) {
    c.on("message", (ctx, next) => {
        ctx.conversation.diveOut(3); // same as ctx.conversation.switch('llr-walk')
        return next();
    });
}
lll.on("message", (ctx) => ctx.reply("You walked LLL. Restarting!"));
llr.on("message", (ctx) => ctx.reply("You walked LLR. Restarting!"));
lrl.on("message", (ctx) => ctx.reply("You walked LRL. Restarting!"));
lrr.on("message", (ctx) => ctx.reply("You walked LRR. Restarting!"));
rll.on("message", (ctx) => ctx.reply("You walked RLL. Restarting!"));
rlr.on("message", (ctx) => ctx.reply("You walked RLR. Restarting!"));
rrl.on("message", (ctx) => ctx.reply("You walked RRL. Restarting!"));
rrr.on("message", (ctx) => ctx.reply("You walked RRR. Restarting!"));

////////////////////////////////////////////////////
/////              DESIGN NOTES                /////
////////////////////////////////////////////////////

// - every conversation has an optional identifier that defaults to index.size
// - every conversation has one composer
// - every conversation has a reference to
//   - its parent,
//   - its predecessor,
//   - its successor, and
//   - its linked list of child conversations
// - every conversation shares a tree-global index of identifier -> conversation, i.e. the flattened out tree structure
// - navigation is performed by traversing the tree structure
// - update handling is performed by O(1) lookup of the right conversation, and running the composer
// - composer-methods are creating a new conversation with identical nodes and changed composer
// - conversation-methods are creating a new conversation with changed nodes and identical composer
// -
