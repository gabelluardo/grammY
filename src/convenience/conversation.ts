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

class ShallowConversation<C extends ConversationContext> {
    protected readonly composer: Composer<C>;
    private handlerCount = 0;
    constructor(...middleware: Array<Middleware<C>>) {
        this.composer = new Composer(...middleware);
    }

    wait() {
        return this.use(() => {
            debug("wait called");
            // do nothing, stop propagating update when reaching wait call
        });
    }

    private track<D extends C>(
        pc: number,
        middleware: Middleware<D>,
    ): MiddlewareFn<D> {
        const handler = new Composer(middleware).middleware();
        return async (ctx, next) => {
            debug("tangent", pc);
            const c = ctx.session.conversation;
            debug("stack is", ctx[replay], ctx[active], c);
            if (c === undefined) throw new Error("Data unavailable!");
            const lastFramePos = c.stack.length - 1;
            const lastFrame = c.stack[lastFramePos];
            if (lastFrame === undefined) throw new Error("No frames!");
            const stackLength = c.stack.length;

            // Check for ongoing replay operation
            const replayPos = ctx[replay];
            if (replayPos !== undefined) {
                debug("replay", pc);
                debug("current target is", handler.toString());
                const replayFrame = c.stack[replayPos.frame];
                const targetPc = replayFrame.pc;
                // If target pc not reached yet, skip handler
                if (pc < targetPc) {
                    debug("skip because not done at", pc);
                    await next();
                    return;
                }

                // Target pc reached, using this frame
                replayPos.frame++;
                debug("Reached target pc, continuing at frame", replayPos);

                // If target pc was reached in target frame, stop replay operation
                if (replayPos.frame === lastFramePos) {
                    debug("done at", pc);
                    debug("stack is", ctx[replay], ctx[active], c);
                    delete ctx[replay];
                    ctx[active] = true;
                    // skip one more handler, it is last active one
                    c.stack.pop();
                    await next();
                    return;
                }
            }

            debug("handler", pc);
            // Store pc during normal execution
            lastFrame.pc = pc;

            if (replayPos === undefined) {
                debug("push stack");
                c.stack.push({ pc: 0 });
            }
            await handler(ctx, async () => {
                debug("pop stack");
                c.stack.splice(stackLength);
                await next();
            });
        };
    }

    private register<D extends C>(
        middleware: Array<Middleware<D>>,
        op: (
            composer: Composer<C>,
            middleware: Array<Middleware<D>>,
        ) => Composer<D>,
    ): ShallowConversation<D> {
        // handler count is pc in own frame
        const pc = this.handlerCount++;
        // index in list is pc in created frame
        const tracked = middleware.map((m, i) => this.track(i, m));
        const pushPop = new Composer<C>();
        const custom = op(pushPop, tracked);
        this.composer.use(this.track(pc, pushPop));
        return new ShallowConversation(custom);
    }

    use(...middleware: Array<Middleware<C>>): ShallowConversation<C> {
        return this.register(middleware, (c, m) => c.use(...m));
    }

    do(...middleware: Array<Middleware<C>>): ShallowConversation<C> {
        return this.register(middleware, (c, m) => c.do(...m));
    }

    filter(
        pred: (ctx: C) => boolean,
        ...middleware: Array<Middleware<C>>
    ): ShallowConversation<C> {
        return this.register(
            middleware,
            (c, m) =>
                c.filter(
                    pred,
                    (_ctx, next) => (console.log("filter true"), next()),
                    ...m,
                ),
        );
    }

    on<Q extends FilterQuery>(
        filter: Q | Q[],
        ...middleware: Array<Middleware<Filter<C, Q>>>
    ): ShallowConversation<Filter<C, Q>> {
        return this.register(middleware, (c, m) => c.on(filter, ...m));
    }
}

export class Conversation<C extends ConversationContext>
    extends ShallowConversation<C>
    implements MiddlewareObj<C> {
    constructor(public readonly identifier: string) {
        super();
    }

    middleware(): MiddlewareFn<C> {
        return async (ctx, next) => {
            const handler = this.composer.middleware();
            const id = this.identifier;
            const session = ctx.session;
            debug("in", id);
            debug("stack is", ctx[replay], ctx[active], session.conversation);

            // Set conversation controls
            const oldEnter = ctx.conversation?.enter;
            ctx.conversation = {
                async enter(identifier) {
                    debug("manual enter");
                    debug(
                        "stack is",
                        ctx[replay],
                        ctx[active],
                        session.conversation,
                    );
                    if (identifier !== id) {
                        await oldEnter?.(identifier);
                        return;
                    }
                    if (session.conversation !== undefined) {
                        throw new Error(
                            `Conversation '${session.conversation.id}' is already running, cannot start '${id}'`,
                        );
                    }
                    ctx[active] = true;
                    session.conversation = { id, stack: [{ pc: 0 }] };
                    await handler(ctx, () => {
                        delete ctx[active];
                        delete session.conversation;
                        return Promise.resolve();
                    });
                },
            };

            // If we are not active, pass through
            if (session.conversation === undefined) {
                debug("not active");
                debug(
                    "stack is",
                    ctx[replay],
                    ctx[active],
                    session.conversation,
                );
                debug("downstream");
                await next();
                debug("downstream done");
                debug(
                    "stack is",
                    ctx[replay],
                    ctx[active],
                    session.conversation,
                );
                return;
            }

            debug("active!");
            const root = ctx[active] === undefined;
            if (root) ctx[replay] = { frame: 0 };
            else session.conversation.stack.push({ pc: 0 });

            debug("root is", root, root ? "base call" : "regular call");

            // Should handle conversation, begin replay
            await handler(ctx, async () => {
                if (root) {
                    delete ctx[active];
                    delete session.conversation;
                } else session.conversation?.stack.pop();
                await next();
            });
        };
    }
}
