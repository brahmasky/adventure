import type {
  NotificationAdapter,
  NotificationDispatchRecord,
  NotificationSendResult
} from "./notification-types.js";

/**
 * Local sink adapter. Delivers notifications to a sink function (stdout by
 * default) and returns a synthetic provider message id so the same delivery
 * machinery applies to local and remote targets.
 */
export class LocalNotificationAdapter implements NotificationAdapter {
  constructor(private readonly sink: (notification: NotificationDispatchRecord) => void = defaultSink) {}

  async send(notification: NotificationDispatchRecord): Promise<NotificationSendResult> {
    this.sink(notification);
    return { provider_message_id: `local:${notification.notification_id}` };
  }
}

function defaultSink(notification: NotificationDispatchRecord): void {
  console.log(JSON.stringify({
    channel: "local",
    notification_id: notification.notification_id,
    intent_type: notification.intent_type,
    text: notification.payload.text
  }));
}
