import SwiftUI

struct SetupView: View {
    @Environment(Store.self) private var store

    var body: some View {
        Group {
            if let checks = store.checks {
                Table(checks) {
                    TableColumn("") { c in
                        Image(systemName: c.ok ? "checkmark.circle.fill" : "xmark.octagon.fill")
                            .foregroundStyle(c.ok ? Color.green : Color.red)
                            .help(c.ok ? "OK" : "Needs a fix")
                            .accessibilityLabel(c.ok ? "OK" : "Needs a fix")
                    }.width(24)
                    TableColumn("Check") { c in Text(c.name).fontWeight(.semibold) }
                    TableColumn("Detail") { c in Text(c.detail).foregroundStyle(.secondary) }
                    TableColumn("Fix") { c in
                        if !c.ok, let fix = c.fix {
                            HStack(spacing: 8) {
                                Text(fix).font(.system(.body, design: .monospaced))
                                IconButton(symbol: "doc.on.doc", label: "Copy Fix", subject: c.name) { copyPlain(fix) }
                            }
                        }
                    }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle("Config")
        .toolbar {
            ToolbarItemGroup {
                if store.busy > 0 { ProgressView().controlSize(.small) }
                ToolbarBtn("Check Config", "arrow.clockwise") { store.runDoctor() }
            }
        }
        .task { if store.checks == nil { store.runDoctor() } }
    }
}
