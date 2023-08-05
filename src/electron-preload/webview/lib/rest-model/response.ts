import {Contact, Context, Conversation, Message} from "src/electron-preload/webview/lib/rest-model/response-entity/mail";
import {Event} from "src/electron-preload/webview/lib/rest-model/response-entity/event";
import {Label} from "src/electron-preload/webview/lib/rest-model/response-entity/folder";

export interface Response {
    Code: number; // 1000 - success
}

export interface ConversationResponse extends Response {
    Conversation: Conversation;
    Messages: Message[];
}

export interface ConversationsResponse extends Response {
    Total: number;
    Limit: number;
    Conversations: Array<Conversation & Context & { Time: number }>;
}

export interface MessageResponse extends Response {
    Message: Message;
}

export interface MessagesResponse extends Response {
    Total: number;
    Limit: number;
    Messages: Array<Omit<Message, "Body" | "Attachments" | "MIMEType" | "ParsedHeaders">>;
}

export interface MessagesCountResponse extends Response {
    Counts: Array<{ LabelID: string, Total: number, Unread: number }>
}

export interface ContactResponse extends Response {
    Contact: Contact;
}

export interface ContactsResponse extends Response {
    Total: number;
    Limit: number;
    Contacts: Array<Omit<Contact, "Cards" | "ContactEmails">>;
}

export interface LabelsResponse extends Response {
    Labels: Label[];
}

export type LatestEventResponse = Response & Pick<Event, "EventID">;

export interface EventResponse extends Response, Event {}
