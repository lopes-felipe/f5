import type {
  MobileApproval,
  MobileMessage,
  MobilePendingInput,
} from "@t3tools/contracts/mobile/v1";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMobileModel } from "../../../src/core/model";
import { mobileSync } from "../../../src/core/sync";
import { MobileRpcError } from "../../../src/core/wsClient";
import { Action, Card, Field, styles, Waiting } from "../../../src/ui";

type Message = typeof MobileMessage.Type;
type Approval = typeof MobileApproval.Type;
type Input = typeof MobilePendingInput.Type;
type Decision = Approval["decisions"][number];
const decisionLabel: Record<Decision, string> = {
  accept: "Approve once",
  decline: "Decline",
  cancel: "Cancel request",
};

function useDecision() {
  const [requested, setRequested] = useState(false);
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const mounted = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  async function run(action: () => Promise<unknown>) {
    if (pending.current) return;
    pending.current = true;
    setRequested(true);
    setNotice("");
    try {
      await action();
      if (!mounted.current) return;
      timer.current = setTimeout(() => {
        pending.current = false;
        setRequested(false);
        setNotice("Check the current outcome before sending again.");
        mobileSync.retry();
      }, 10_000);
    } catch (error) {
      if (!mounted.current) return;
      const code = error instanceof MobileRpcError ? error.code : null;
      setNotice(
        code === "stale-action"
          ? "This request may have been answered on another device."
          : code === "host-only"
            ? "Open this request on the host."
            : "The request could not be confirmed.",
      );
      pending.current = false;
      setRequested(false);
    }
  }
  const message = requested ? "Requested" : notice;
  return { run, requested, message };
}

function StopTurnCard({
  threadId,
  turnId,
  disabled,
}: {
  threadId: string;
  turnId: string;
  disabled: boolean;
}) {
  const stop = useDecision();
  return (
    <Card>
      <Action
        label="Stop turn"
        quiet
        disabled={disabled || stop.requested}
        onPress={() => void stop.run(() => mobileSync.rpc("interrupt", { threadId, turnId }, true))}
      />
      {stop.message && (
        <Text accessibilityLiveRegion="polite" style={styles.muted}>
          {stop.message}
        </Text>
      )}
    </Card>
  );
}

function ApprovalCard({
  approval,
  threadId,
  disabled,
}: {
  approval: Approval;
  threadId: string;
  disabled: boolean;
}) {
  const decision = useDecision();
  return (
    <Card title={approval.title || "Approval needed"}>
      {approval.description && (
        <Text selectable style={styles.text}>
          {approval.description}
        </Text>
      )}
      {approval.decisionReason && (
        <Text selectable style={styles.muted}>
          {approval.decisionReason}
        </Text>
      )}
      {approval.detail && (
        <Text selectable style={styles.text}>
          {approval.detail}
        </Text>
      )}
      {approval.decisions.length ? (
        <View style={styles.row}>
          {approval.decisions.map((choice) => (
            <Action
              key={choice}
              label={decisionLabel[choice]}
              quiet={
                approval.defaultToNo || approval.decisions[0] === "decline"
                  ? choice !== "decline"
                  : choice !== "accept"
              }
              disabled={disabled || decision.requested}
              onPress={() =>
                void decision.run(() =>
                  mobileSync.rpc(
                    "respondToApproval",
                    { threadId, requestId: approval.requestId, decision: choice },
                    true,
                  ),
                )
              }
            />
          ))}
        </View>
      ) : (
        <Text style={styles.muted}>Open this approval on the host.</Text>
      )}
      {decision.message && (
        <Text accessibilityLiveRegion="polite" style={styles.muted}>
          {decision.message}
        </Text>
      )}
    </Card>
  );
}

function QuestionCard({
  input,
  threadId,
  disabled,
}: {
  input: Input;
  threadId: string;
  disabled: boolean;
}) {
  const [answers, setAnswers] = useState<Record<string, string | readonly string[]>>(() =>
    Object.fromEntries(
      input.questions.flatMap((question) =>
        question.initialAnswer && question.allowCustomAnswer !== false
          ? [[question.id, question.initialAnswer]]
          : [],
      ),
    ),
  );
  const decision = useDecision();
  const unavailable = disabled || decision.requested;
  const incomplete = input.questions.some((question) => {
    const answer = answers[question.id];
    return !question.optional && (typeof answer === "string" ? !answer.trim() : !answer?.length);
  });
  if (input.hostOnly)
    return (
      <Card title="Answer needed">
        <Text style={styles.muted}>Open this question on the host.</Text>
      </Card>
    );
  return (
    <Card title="Answer needed">
      {input.responseMode === "message" && (
        <Text style={styles.muted}>Your answers will send a follow-up message.</Text>
      )}
      {input.questions.map((question) => {
        const current = answers[question.id];
        const selected = Array.isArray(current) ? current : [];
        return (
          <View key={question.id} style={{ gap: 8, marginVertical: 5 }}>
            <Text style={styles.heading}>
              {question.header}
              {question.optional ? " (optional)" : ""}
            </Text>
            <Text selectable style={styles.text}>
              {question.question}
            </Text>
            {question.options.map((option) => {
              const value = option.value ?? option.label;
              const checked = selected.includes(value);
              return (
                <View key={value} style={{ gap: 3 }}>
                  <Action
                    label={(checked ? "Selected · " : "") + option.label}
                    quiet={!checked}
                    disabled={unavailable}
                    onPress={() =>
                      setAnswers((previous) => ({
                        ...previous,
                        [question.id]: question.multiSelect
                          ? checked
                            ? selected.filter((choice) => choice !== value)
                            : [...selected, value]
                          : checked && question.optional
                            ? []
                            : [value],
                      }))
                    }
                  />
                  {!!option.description && <Text style={styles.muted}>{option.description}</Text>}
                </View>
              );
            })}
            {question.allowCustomAnswer !== false && (
              <Field
                accessibilityLabel={question.header + " custom answer"}
                editable={!unavailable}
                value={typeof current === "string" ? current : ""}
                placeholder="Type an answer"
                multiline
                maxLength={8000}
                onChangeText={(text) =>
                  setAnswers((previous) => ({ ...previous, [question.id]: text }))
                }
              />
            )}
          </View>
        );
      })}
      <View style={styles.row}>
        <Action
          label="Submit answers"
          disabled={unavailable || incomplete}
          onPress={() => {
            const values = Object.fromEntries(
              input.questions.map((question) => {
                const answer = answers[question.id];
                return [
                  question.id,
                  typeof answer === "string"
                    ? answer.trim()
                    : question.multiSelect && answer?.length
                      ? answer
                      : (answer?.[0] ?? ""),
                ];
              }),
            );
            void decision.run(() =>
              mobileSync.rpc(
                "respondToQuestion",
                { threadId, requestId: input.requestId, answers: values },
                true,
              ),
            );
          }}
        />
        <Action
          label="Dismiss"
          quiet
          disabled={unavailable}
          onPress={() =>
            void decision.run(() =>
              mobileSync.rpc("dismissQuestion", { threadId, requestId: input.requestId }, true),
            )
          }
        />
      </View>
      {decision.message && (
        <Text accessibilityLiveRegion="polite" style={styles.muted}>
          {decision.message}
        </Text>
      )}
    </Card>
  );
}

export default function ThreadScreen() {
  const { serverId, threadId } = useLocalSearchParams<{ serverId: string; threadId: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const server = useMobileModel((state) => state.server);
  const shell = useMobileModel((state) =>
    state.shell?.threads.find((thread) => thread.id === threadId),
  );
  const detail = useMobileModel((state) => (threadId ? state.details.get(threadId) : undefined));
  const stale = useMobileModel((state) => state.stale);
  const status = useMobileModel((state) => state.status);
  const syncTimedOut = useMobileModel((state) => state.syncTimedOut);
  const list = useRef<FlatList<Message>>(null);
  const follows = useRef(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [jump, setJump] = useState(false);
  useFocusEffect(
    useCallback(() => {
      if (server?.serverId === serverId && threadId) mobileSync.select(threadId);
      return () => mobileSync.select(null);
    }, [server?.serverId, serverId, threadId]),
  );
  if (!server || server.serverId !== serverId || !threadId)
    return (
      <View style={[styles.screen, styles.content]}>
        <Text style={styles.text}>Pair with this server to open the conversation.</Text>
        <Action label="Go to Home" onPress={() => router.replace("/")} />
      </View>
    );
  if (!detail && !syncTimedOut && (status === "syncing" || status === "connecting"))
    return <Waiting />;
  if (!detail && !shell && status === "ready")
    return (
      <View style={[styles.screen, styles.content]}>
        <Text style={styles.text}>This conversation is no longer available.</Text>
        <Action label="Go to Home" onPress={() => router.replace("/")} />
      </View>
    );
  const activeTurn = shell?.activeTurnId;
  const disabled = stale || status !== "ready";

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: shell?.title ?? "Conversation" }} />
      <FlatList
        ref={list}
        data={detail?.messages ?? []}
        keyExtractor={(message) => message.messageId}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 16 }]}
        keyboardShouldPersistTaps="handled"
        maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
        scrollEventThrottle={50}
        onScroll={({ nativeEvent }) => {
          const remaining =
            nativeEvent.contentSize.height -
            nativeEvent.contentOffset.y -
            nativeEvent.layoutMeasurement.height;
          follows.current = remaining < 100;
          setJump(!follows.current);
        }}
        onContentSizeChange={() => {
          if (follows.current) list.current?.scrollToEnd({ animated: false });
        }}
        ListHeaderComponent={
          <View style={{ gap: 10 }}>
            {disabled && (
              <Card>
                <Text style={styles.muted}>
                  {syncTimedOut
                    ? "Still syncing"
                    : status === "offline"
                      ? "Host offline. Check Tailscale and make sure the host is awake."
                      : status === "access-off"
                        ? "Phone access is off on the host."
                        : "Syncing this conversation…"}
                </Text>
                <Action label="Retry" quiet onPress={mobileSync.retry} />
              </Card>
            )}
            {detail?.cursor && (
              <Action
                label={historyLoading ? "Loading…" : "Load earlier messages"}
                quiet
                disabled={historyLoading || disabled}
                onPress={() => {
                  follows.current = false;
                  setHistoryLoading(true);
                  setHistoryError(false);
                  void mobileSync
                    .history(threadId)
                    .catch(() => setHistoryError(true))
                    .finally(() => setHistoryLoading(false));
                }}
              />
            )}
            {historyError && <Text style={styles.alert}>Could not load earlier messages.</Text>}
          </View>
        }
        renderItem={({ item }) => (
          <Card
            title={
              item.role === "user" ? "You" : item.role === "assistant" ? "Agent" : "Conversation"
            }
          >
            <Text selectable style={styles.text}>
              {item.text || (item.streaming ? "…" : "")}
            </Text>
          </Card>
        )}
        ListFooterComponent={
          <View style={{ gap: 12 }}>
            {detail?.plan && (
              <Card title="Proposed plan">
                <Text selectable style={styles.text}>
                  {detail.plan}
                </Text>
              </Card>
            )}
            {detail?.approvals.map((approval) => (
              <ApprovalCard
                key={approval.requestId}
                approval={approval}
                threadId={threadId}
                disabled={disabled}
              />
            ))}
            {detail?.pendingInputs.map((input) => (
              <QuestionCard
                key={input.requestId}
                input={input}
                threadId={threadId}
                disabled={disabled}
              />
            ))}
            {activeTurn && (
              <StopTurnCard
                key={threadId + ":" + activeTurn}
                threadId={threadId}
                turnId={activeTurn}
                disabled={disabled}
              />
            )}
          </View>
        }
      />
      {jump && (
        <View style={{ position: "absolute", right: 16, bottom: insets.bottom + 12 }}>
          <Action
            label="Jump to latest"
            onPress={() => {
              follows.current = true;
              setJump(false);
              list.current?.scrollToEnd({ animated: true });
            }}
          />
        </View>
      )}
    </View>
  );
}
