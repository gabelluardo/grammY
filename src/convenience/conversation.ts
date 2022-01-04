import { Context } from "../context.ts";
import {
    Composer,
    Middleware,
    MiddlewareFn,
    MiddlewareObj,
} from "../composer.ts";
import { SessionFlavor } from "./session.ts";
import { Filter, FilterQuery } from "../filter.ts";

interface ConversationSessionData {
    conversation?: { stack: StackFrame[]; replayIndex?: number };
}

interface StackFrame {
    id: string;
    pc: number;
}

interface ConversationControls {
    enter(identifier: string): void;
    exit(): void;
}

const main = Symbol();

export type ConversationFlavor =
    & { conversation: ConversationControls; [main]?: true }
    & SessionFlavor<ConversationSessionData>;

type ConversationContext =
    & Context
    & ConversationFlavor
    & SessionFlavor<Required<ConversationSessionData>>;

class ShallowConversation<C extends ConversationContext> {
    constructor(
        public readonly identifier: string,
        protected readonly composer = new Composer<C>(),
        protected index = new Array<Middleware<C>>(),
    ) {}

    wait() {
        return this.use(() => {
            // do nothing, stop propagating update when reaching wait call
        });
    }

    private setPc<D extends C>(pc: number): MiddlewareFn<D> {
        return (ctx, next) => {
            const stack = ctx.session.conversation.stack;
            if (stack.length === 0) {
                throw new Error(
                    `Fatal: Empty stack while incpc to ${pc} at ${this.identifier}!`,
                );
            }
            stack[stack.length - 1].pc = pc;
            return next();
        };
    }

    private *register<D extends C>(
        middleware: Array<Middleware<D>>,
    ): Generator<Middleware<D>> {
        for (const m of middleware) {
            const ic = this.index.length; // next instruction count
            const pcUpd = this.setPc(ic);
            this.index.push(pcUpd);
            yield pcUpd;
            yield m;
        }
    }

    use(...middleware: Array<Middleware<C>>): ShallowConversation<C> {
        return new ShallowConversation<C>(
            this.identifier,
            this.composer.use(...this.register(middleware)),
            this.index,
        );
    }

    filter(
        pred: (ctx: C) => boolean,
        ...middleware: Array<Middleware<C>>
    ): ShallowConversation<C> {
        return new ShallowConversation(
            this.identifier,
            this.composer.filter(pred, ...this.register(middleware)),
            this.index,
        );
    }

    on<Q extends FilterQuery>(
        filter: Q | Q[],
        ...middleware: Array<Middleware<Filter<C, Q>>>
    ): ShallowConversation<Filter<C, Q>> {
        return new ShallowConversation(
            this.identifier,
            this.composer.on(filter, ...this.register(middleware)),
            this.index,
        );
    }
    // hears(h: string | RegExp, ...middleware: Array<Middleware<C>>): ShallowConversation<Filter<C, Q>> {
    //     return this.wrapComposer((c) => c.hears(h, ...middleware));
    // }
    // command(h: string, ...middleware: Array<Middleware<C>>): ShallowConversation<Filter<C, Q>> {
    //     return this.wrapComposer((c) => c.command(h, ...middleware));
    // }
    // callbackQuery(h: string, ...middleware: Array<Middleware<C>>): ShallowConversation<Filter<C, Q>> {
    //     return this.wrapComposer((c) => c.callbackQuery(h, ...middleware));
    // }
}

export class Conversation<C extends ConversationContext>
    extends ShallowConversation<C>
    implements MiddlewareObj<C> {
    constructor(identifier: string) {
        super(identifier);
    }

    middleware(): MiddlewareFn<C> {
        return async (ctx, next) => {
            const id = this.identifier;
            let runTarget: Middleware<C> = this.composer;

            const conversation = ctx.session.conversation;
            const stack = conversation.stack;

            async function call() {
                enter(id);
                await run();
            }
            async function run() {
                const flat = new Composer(runTarget).middleware();
                await flat(ctx, () => (leave(), next()));
            }

            // Define and install common operations
            function enter(id: string) {
                if (main in ctx) {
                    throw new Error(
                        "Already in conversation, cannot enter another one",
                    );
                }
                ctx[main] = true;
                stack.push({ id, pc: 0 });
            }
            function leave() {
                stack.pop();
                if (stack.length === 0) delete ctx[main];
            }
            function exit() {
                delete (ctx.session as Partial<typeof ctx.session>)
                    .conversation;
            }
            ctx.conversation ??= { enter, exit }; // omit leave

            // A conversation is already running, only perform function call
            if (main in ctx) {
                await call();
                return;
            }

            // We are a stack frame in an ongoing replay operation
            if (conversation.replayIndex !== undefined) {
                // We are the final frame
                if (conversation.replayIndex === stack.length - 1) {
                    // Resume execution one handler later than last time
                    runTarget = this.index[conversation.replayIndex + 1];
                    // Store that the replay operation is complete now
                    ctx[main] = true;
                    delete conversation.replayIndex;
                } else {
                    // Resume execution exactly at same instruction
                    runTarget = this.index[conversation.replayIndex];
                }
                await run();
                return;
            }

            // We are installed on regular middleware. Currently, no
            // conversation is running.

            // If we are not in a conversation, call downstream middleware
            let nextCalled = false;
            if (stack.length === 0) {
                await next();
                nextCalled = true;
            }

            // If the downstream middleware did not enter us, we are done
            if (stack.length === 0) return;

            // We should be in a conversation now, but we are not. Hence, we
            // enter one by replaying the stack and beginning execution.
            const bottom = stack[0];

            // Do not handle things if we are not responsible
            if (bottom.id !== id) {
                if (!nextCalled) await next();
                return;
            }

            // Start replaying the stack.
            conversation.replayIndex = 0;
            // In case we were previously entered from downstream middleware, we
            // have to make sure not to call downstream middleware again after
            // completing execution. We simply pass a no-op for `next`.
            const nextNext = nextCalled ? () => Promise.resolve() : next;
            await this.middleware()(ctx, nextNext); // recurse once
        };
    }
}
