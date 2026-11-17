// theo-events: a small EventKit bridge for Calendar and Reminders.
//
// Usage: theo-events <command> [json-arguments]
// Every command prints one JSON value on stdout. Failures print {"error": "..."}.
// Dates cross the boundary as Unix epoch seconds so the caller owns formatting.

import EventKit
import Foundation

let store = EKEventStore()

func emit(_ value: Any) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: value)) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    exit(0)
}

func fail(_ message: String) -> Never {
    emit(["error": message])
}

func statusName(_ type: EKEntityType) -> String {
    switch EKEventStore.authorizationStatus(for: type) {
    case .notDetermined: return "notDetermined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .fullAccess: return "granted"
    case .writeOnly: return "writeOnly"
    @unknown default: return "granted"
    }
}

func request(_ type: EKEntityType) -> Bool {
    let done = DispatchSemaphore(value: 0)
    var granted = false
    let handler: (Bool, Error?) -> Void = { ok, _ in
        granted = ok
        done.signal()
    }
    if type == .event {
        store.requestFullAccessToEvents(completion: handler)
    } else {
        store.requestFullAccessToReminders(completion: handler)
    }
    done.wait()
    return granted
}

func requireAccess(_ type: EKEntityType) {
    let status = statusName(type)
    if status == "granted" { return }
    if status == "notDetermined", request(type) { return }
    let name = type == .event ? "Calendar" : "Reminders"
    fail("DesktopJarvis does not have access to \(name). Allow it in System Settings › Privacy & Security › \(name == "Calendar" ? "Calendars" : "Reminders").")
}

func date(_ value: Any?) -> Date? {
    guard let seconds = value as? Double else { return nil }
    return Date(timeIntervalSince1970: seconds)
}

func epoch(_ value: Date?) -> Any {
    guard let value else { return NSNull() }
    return value.timeIntervalSince1970
}

func fetchReminders(_ predicate: NSPredicate) -> [EKReminder] {
    let done = DispatchSemaphore(value: 0)
    var found: [EKReminder] = []
    store.fetchReminders(matching: predicate) { reminders in
        found = reminders ?? []
        done.signal()
    }
    done.wait()
    return found
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else { fail("Missing command") }
let command = arguments[1]
var input: [String: Any] = [:]
if arguments.count >= 3,
   let parsed = try? JSONSerialization.jsonObject(with: Data(arguments[2].utf8)) as? [String: Any] {
    input = parsed
}

switch command {
case "status":
    emit(["calendar": statusName(.event), "reminders": statusName(.reminder)])

case "request":
    let type: EKEntityType = (input["kind"] as? String) == "reminders" ? .reminder : .event
    let granted = request(type)
    emit(["granted": granted, "status": statusName(type)])

case "calendars":
    requireAccess(.event)
    emit(store.calendars(for: .event).map { ["title": $0.title, "writable": $0.allowsContentModifications] })

case "events":
    requireAccess(.event)
    guard let start = date(input["start"]), let end = date(input["end"]) else {
        fail("events needs start and end")
    }
    let predicate = store.predicateForEvents(withStart: start, end: end, calendars: nil)
    let events = store.events(matching: predicate).sorted { $0.startDate < $1.startDate }
    emit(events.prefix(60).map { event -> [String: Any] in
        [
            "id": event.eventIdentifier ?? "",
            "title": event.title ?? "",
            "start": epoch(event.startDate),
            "end": epoch(event.endDate),
            "allDay": event.isAllDay,
            "calendar": event.calendar?.title ?? "",
            "location": event.location ?? "",
        ]
    })

case "add-event":
    requireAccess(.event)
    guard let title = input["title"] as? String, let start = date(input["start"]) else {
        fail("add-event needs a title and start")
    }
    let event = EKEvent(eventStore: store)
    event.title = title
    event.startDate = start
    event.endDate = date(input["end"]) ?? start.addingTimeInterval(3600)
    event.isAllDay = (input["allDay"] as? Bool) ?? false
    event.location = input["location"] as? String
    event.notes = input["notes"] as? String
    if let wanted = input["calendar"] as? String,
       let match = store.calendars(for: .event).first(where: {
           $0.allowsContentModifications && $0.title.localizedCaseInsensitiveContains(wanted)
       }) {
        event.calendar = match
    } else {
        event.calendar = store.defaultCalendarForNewEvents
    }
    guard event.calendar != nil else { fail("No writable calendar found") }
    do {
        try store.save(event, span: .thisEvent, commit: true)
    } catch {
        fail("Could not save the event: \(error.localizedDescription)")
    }
    emit(["id": event.eventIdentifier ?? "", "calendar": event.calendar.title])

case "reminders":
    requireAccess(.reminder)
    let includeCompleted = (input["includeCompleted"] as? Bool) ?? false
    let predicate = includeCompleted
        ? store.predicateForReminders(in: nil)
        : store.predicateForIncompleteReminders(
            withDueDateStarting: nil, ending: date(input["dueBefore"]), calendars: nil)
    let reminders = fetchReminders(predicate).sorted {
        let a = $0.dueDateComponents?.date ?? .distantFuture
        let b = $1.dueDateComponents?.date ?? .distantFuture
        return a < b
    }
    emit(reminders.prefix(60).map { reminder -> [String: Any] in
        [
            "id": reminder.calendarItemIdentifier,
            "title": reminder.title ?? "",
            "due": epoch(reminder.dueDateComponents?.date),
            "completed": reminder.isCompleted,
            "list": reminder.calendar?.title ?? "",
            "notes": reminder.notes ?? "",
        ]
    })

case "add-reminder":
    requireAccess(.reminder)
    guard let title = input["title"] as? String else { fail("add-reminder needs a title") }
    let reminder = EKReminder(eventStore: store)
    reminder.title = title
    reminder.notes = input["notes"] as? String
    if let wanted = input["list"] as? String,
       let match = store.calendars(for: .reminder).first(where: {
           $0.allowsContentModifications && $0.title.localizedCaseInsensitiveContains(wanted)
       }) {
        reminder.calendar = match
    } else {
        reminder.calendar = store.defaultCalendarForNewReminders()
    }
    guard reminder.calendar != nil else { fail("No reminders list found") }
    if let due = date(input["due"]) {
        reminder.dueDateComponents = Calendar.current.dateComponents(
            [.year, .month, .day, .hour, .minute], from: due)
        reminder.addAlarm(EKAlarm(absoluteDate: due))
    }
    do {
        try store.save(reminder, commit: true)
    } catch {
        fail("Could not save the reminder: \(error.localizedDescription)")
    }
    emit(["id": reminder.calendarItemIdentifier, "list": reminder.calendar.title])

case "complete-reminder":
    requireAccess(.reminder)
    guard let id = input["id"] as? String,
          let reminder = store.calendarItem(withIdentifier: id) as? EKReminder else {
        fail("No reminder with that id")
    }
    reminder.isCompleted = true
    do {
        try store.save(reminder, commit: true)
    } catch {
        fail("Could not update the reminder: \(error.localizedDescription)")
    }
    emit(["completed": true, "title": reminder.title ?? ""])

default:
    fail("Unknown command \(command)")
}
