import SwiftUI

struct SignInView: View {
    @Environment(AppStore.self) private var store
    @State private var email = ""
    @State private var password = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Image(systemName: "indianrupeesign.circle.fill")
                            .font(.system(size: 44))
                            .foregroundStyle(.tint)
                        Text("Finance")
                            .font(.largeTitle.bold())
                        Text("Sign in with the account you use on the web.")
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 8)
                    .listRowBackground(Color.clear)
                }

                Section("Account") {
                    TextField("Email", text: $email)
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .onSubmit(signIn)
                }

                if let error {
                    Section {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Button(action: signIn) {
                        HStack {
                            Spacer()
                            if busy { ProgressView() } else { Text("Sign In").bold() }
                            Spacer()
                        }
                    }
                    .disabled(busy || email.isEmpty || password.isEmpty)
                }
            }
        }
    }

    private func signIn() {
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                try await store.api.signIn(email: email, password: password)
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}
