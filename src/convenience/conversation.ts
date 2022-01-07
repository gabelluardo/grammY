import { Context } from "../context.ts";
import {
    Composer,
    Middleware,
    MiddlewareFn,
    MiddlewareObj,
} from "../composer.ts";
import { SessionFlavor } from "./session.ts";
import { Filter, FilterQuery } from "../filter.ts";
import { debug as d } from "../platform.deno.ts";
const debug = d("grammy:conversation");

const replay = Symbol("ongoing replay operation");
const active = Symbol("function call indicator");

interface ConversationSessionData {
    conversation?: {
        /** Identifier of the conversation */
        id: string;
        /** Call stack inside conversation */
        stack: StackFrame[];
    };
}
interface StackFrame {
    /** Program counter, counts installed middlewares depth-first */
    pc: number;
}

interface ConversationControls {
    enter(identifier: string): Promise<void>;
}

export interface ConversationFlavor
    extends SessionFlavor<ConversationSessionData> {
    conversation: ConversationControls;
    [replay]?: { frame: number };
    [active]?: true;
}

type ConversationContext = Context & ConversationFlavor;

function getStackData<C extends ConversationContext>(ctx: C) {
    const conversation = ctx.session.conversation;
    if (conversation === undefined) throw new Error("No data available!");
    const stack = conversation.stack;
    const lastFramePos = stack.length - 1;
    const lastFrame = stack[lastFramePos];
    return { stack, lastFramePos, lastFrame };
}

function trackpc<C extends ConversationContext>(
    mw: Middleware<C>,
    pc: number,
): MiddlewareFn<C> {
    const handler = new Composer(mw).middleware();
    return async (ctx, next) => {
        const { stack, lastFrame, lastFramePos } = getStackData(ctx);

        const replayPos = ctx[replay];
        if (replayPos !== undefined) {
            // Perform replay operation
            const replayFrame = stack[replayPos.frame];
            const targetPc = replayFrame.pc;
            if (pc < targetPc) {
                // Target pc not reached, skip calling handler
                await next();
                return;
            }
            if (replayPos.frame === lastFramePos) {
                // Replay done, skip one more handler and resume execution normally
                delete ctx[replay];
                ctx[active] = true;
                await next();
                return;
            }
            // Target reached in current frame, call handler to replay next frame
        } else {
            // Normal execution, keep track of program counter and call handler
            debug("setpc", stack);
            lastFrame.pc = pc;
        }

        await handler(ctx, next);
    };
}

class ShallowConversation<B extends ConversationContext, C extends B = B>
    implements MiddlewareObj<C> {
    protected readonly composer: Composer<C>;
    private handlerCount: number;
    constructor(...middleware: Array<Middleware<C>>) {
        this.composer = new Composer(...middleware.map(trackpc));
        this.handlerCount = middleware.length;
    }

    wait(): ShallowConversation<B> {
        const terminate = this.use(() => {
            debug("wait called");
            // do nothing, stop propagating update when reaching wait call
        });
        // If the returned conversation is extended, it will be called with a
        // fresh update, so the types need to be widened again.
        return terminate as unknown as ShallowConversation<B, B>;
    }

    private register<D extends C>(
        middleware: Array<Middleware<D>>,
        op: (
            composer: Composer<C>,
            middleware: Middleware<D>,
        ) => Composer<D>,
    ): ShallowConversation<C, D> {
        const conversation = new ShallowConversation(...middleware);
        op(this.composer, trackpc(conversation, this.handlerCount++));
        return conversation;
    }

    use(...middleware: Array<Middleware<C>>): ShallowConversation<C> {
        return this.register(middleware, (c, m) => c.use(m));
    }

    do(...middleware: Array<Middleware<C>>): ShallowConversation<C> {
        return this.register(middleware, (c, m) => c.do(m));
    }

    filter(
        pred: (ctx: C) => boolean,
        ...middleware: Array<Middleware<C>>
    ): ShallowConversation<C> {
        return this.register(middleware, (c, m) =>
            c.filter((ctx) => {
                debug("eval filter");
                return pred(ctx);
            }, m));
    }

    on<Q extends FilterQuery>(
        filter: Q | Q[],
        ...middleware: Array<Middleware<Filter<C, Q>>>
    ): ShallowConversation<B, Filter<C, Q>> {
        return this.register(middleware, (c, m) => c.on(filter, m));
    }

    middleware(): MiddlewareFn<C> {
        return async (ctx, next) => {
            const { stack } = getStackData(ctx);

            const replayPos = ctx[replay];
            if (replayPos !== undefined) {
                // Replaying, perform virtual stack push
                replayPos.frame++;
            } else {
                // Normal execution, keep track of stack
                stack.push({ pc: 0 });
                debug("stack push", stack);
            }

            await this.composer.middleware()(ctx, async () => {
                debug("stack pop", stack);
                stack.pop();
                await next();
            });
        };
    }
}

export class Conversation<C extends ConversationContext>
    extends ShallowConversation<C, C> {
    constructor(public readonly identifier: string) {
        super();
    }

    middleware(): MiddlewareFn<C> {
        const handler = super.middleware();
        return async (ctx, next) => {
            const id = this.identifier;
            const session = ctx.session;

            function enter() {
                debug("enter");
                ctx[active] = true;
            }
            function leave() {
                debug("leave");
                delete ctx[active];
                delete session.conversation;
            }

            // Set conversation controls
            const oldEnter = ctx.conversation?.enter;
            ctx.conversation = {
                async enter(identifier) {
                    if (identifier !== id) {
                        await oldEnter?.(identifier);
                        return;
                    }
                    if (session.conversation !== undefined) {
                        throw new Error(
                            `Conversation '${session.conversation.id}' is already running, cannot start '${id}'`,
                        );
                    }
                    session.conversation = { id, stack: [] };
                    enter();
                    await handler(ctx, () => {
                        leave();
                        return Promise.resolve();
                    });
                },
            };

            // If we are not active, pass through
            if (session.conversation === undefined) {
                debug("not active, skipping");
                await next();
                return;
            }

            debug("active!");
            const root = ctx[active] === undefined;
            if (root) {
                ctx[replay] = { frame: 0 };
            }

            // Should handle conversation, begin replay
            await handler(ctx, async () => {
                if (root) leave();
                await next();
            });
        };
    }
}
