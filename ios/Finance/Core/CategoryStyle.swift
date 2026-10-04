import SwiftUI

/// How a category looks: an SF Symbol and a tint. Presentation only; the
/// category list itself comes from the server.
enum CategoryStyle {
    static func symbol(_ category: String?) -> String {
        switch category {
        case "Bike": "scooter"
        case "Credit Card Bill": "creditcard"
        case "Dividend / Interest": "chart.line.uptrend.xyaxis"
        case "EMI / Loan": "building.columns"
        case "Entertainment": "popcorn"
        case "Fitness": "figure.badminton"
        case "Food & Dining": "fork.knife"
        case "Groceries": "cart"
        case "Health & Medical": "cross.case"
        case "Insurance": "shield.lefthalf.filled"
        case "Investment": "chart.pie"
        case "Other": "ellipsis"
        case "Refund": "arrow.uturn.backward"
        case "Salary / Income": "indianrupeesign"
        case "Self Transfer": "arrow.left.arrow.right"
        case "Shopping": "bag"
        case "Subscription": "repeat"
        case "Travel & Transport": "car"
        case "Utilities": "bolt"
        default: "questionmark"
        }
    }

    static func color(_ category: String?) -> Color {
        switch category {
        case "Bike": .orange
        case "Credit Card Bill": .gray
        case "Dividend / Interest": .mint
        case "EMI / Loan": .indigo
        case "Entertainment": .pink
        case "Fitness": Color(hue: 0.38, saturation: 0.8, brightness: 0.72)
        case "Food & Dining": .orange
        case "Groceries": .green
        case "Health & Medical": .red
        case "Insurance": .teal
        case "Investment": .blue
        case "Other": .gray
        case "Refund": .green
        case "Salary / Income": .green
        case "Self Transfer": .gray
        case "Shopping": .purple
        case "Subscription": .cyan
        case "Travel & Transport": .blue
        case "Utilities": .yellow
        default: .secondary
        }
    }
}
