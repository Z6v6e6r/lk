workspace "PadlHub Current System" "Current-state C4 workspace for PadlHub LK migration." {
    model {
        client = person "Client" "PadlHub user using LK through web, Android, or iOS."
        operator = person "ЦУП Operator" "Support/admin operator."

        padlhub = softwareSystem "PadlHub LK" "Current LK system and future API boundary." {
            tilda = container "Tilda Pages" "Embeds LK loaders and root containers." "Tilda/HTML"
            bundles = container "React IIFE Bundles" "Cabinet and overlay modules." "React 19, TypeScript, Vite"
            nodered = container "Node-RED / SERV2 Backend" "Current HTTP backend and automation layer." "Node-RED"
            mongo = container "MongoDB" "Current local LK state and read models." "MongoDB"
            scripts = container "Ops Scripts" "Repair, recalculation, deploy, Node-RED patch/build scripts." "Node.js/TypeScript"
            targetApi = container "Target PadlHub API / BFF" "Stable /api/v1 boundary for web and mobile clients." "TypeScript backend" {
                tags "Target"
            }
        }

        viva = softwareSystem "VivaCRM" "External CRM for bookings, subscriptions, exercises, and profile data." {
            tags "External"
        }
        auth = softwareSystem "Keycloak / Viva Auth" "External authentication and token provider." {
            tags "External"
        }
        payment = softwareSystem "Payment Provider" "External payment and callback provider." {
            tags "External"
        }
        max = softwareSystem "MAX" "External messenger/bot integration." {
            tags "External"
        }
        fcm = softwareSystem "Firebase FCM / Future APNS" "Push delivery providers." {
            tags "External"
        }

        client -> tilda "Opens web entrypoints"
        client -> targetApi "Uses future mobile/API contract"
        operator -> nodered "Uses support/admin flows"
        tilda -> bundles "Loads release-manifested bundles"
        bundles -> nodered "Calls current LK APIs"
        bundles -> viva "Calls some Viva endpoints directly"
        bundles -> auth "Authenticates and restores session"
        nodered -> mongo "Reads/writes local LK state"
        nodered -> viva "Creates/cancels/syncs bookings and exercises"
        nodered -> payment "Confirms/reconciles payments"
        nodered -> max "Routes support messages"
        nodered -> fcm "Sends/registers push notifications"
        scripts -> mongo "Repair/recalculate"
        scripts -> nodered "Patch/build/import flow artifacts"
        scripts -> viva "Repair/sync external state"
        targetApi -> nodered "Legacy adapter during migration"
        targetApi -> mongo "Legacy/read model access during migration"
        targetApi -> viva "Typed adapter"
        targetApi -> auth "Identity/session adapter"
    }

    views {
        systemContext padlhub "current-system-context" {
            include *
            autolayout lr
        }

        container padlhub "current-container-view" {
            include *
            autolayout lr
        }

        styles {
            element "Person" {
                shape Person
                background #08427b
                color #ffffff
            }
            element "External" {
                background #f97316
                color #111827
            }
            element "Target" {
                background #7c3aed
                color #ffffff
            }
            element "Container" {
                background #2563eb
                color #ffffff
            }
        }
    }
}
