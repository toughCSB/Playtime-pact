using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Security.AccessControl;
using System.Security.Principal;
using System.ServiceProcess;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class PlaytimePactInstallerAuth
{
    private const string ProductName = "Playtime Pact";
    private const string ServiceName = "PlaytimePactPrivilegedBroker";
    private const string VerificationServiceName = "PlaytimePactInstallerAuthVerifier";
    private static readonly string Root = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "PlaytimePact");
    private static readonly string AdminDir = Path.Combine(Root, "Admin");
    private static readonly string SecretPath = Path.Combine(AdminDir, "admin-secret.json");
    private static readonly string AuthorizationPath = Path.Combine(AdminDir, "installer-upgrade-authorized.txt");
    private static readonly string DiagnosticPath = Path.Combine(Root, "installer-auth.log");
    private static string lastDiagnostic = "not-run";

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            if (HasArgument(args, "--system-verify")) return RunSystemVerifier(args);
            if (HasArgument(args, "--self-test")) return SelfTest();
            if (!IsAdministrator())
            {
                WriteDiagnostic("administrator-required");
                return 7;
            }
            if (HasArgument(args, "--recover-pin")) return RecoverPin();
            if (HasArgument(args, "--diagnose-protection")) return DiagnoseProtection();
            if (HasArgument(args, "--repair-protection")) return RepairProtection();
            if (HasArgument(args, "--authorize-upgrade")) return AuthorizeUpgrade();
            if (HasArgument(args, "--verify")) return PromptAndVerify() ? 0 : 4;
            if (HasArgument(args, "--clear-authorization"))
            {
                DeleteAuthorization();
                return 0;
            }

            // electron-builder invokes the registered old uninstaller with /S.
            // A short-lived, administrator-only marker proves customInit already
            // verified the parent PIN before this legacy cleanup path is entered.
            return CleanupLegacyUpgrade(args);
        }
        catch (Exception ex)
        {
            WriteDiagnostic("exception-" + ex.GetType().Name);
            MessageBox.Show(
                "기존 버전 정리 중 오류가 발생했습니다. 설치 파일은 제거하지 않았습니다.\r\n\r\n" + ex.Message,
                ProductName + " 설치",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 8;
        }
    }

    private static int SelfTest()
    {
        byte[] salt = Encoding.ASCII.GetBytes("12345678");
        using (var derive = new Rfc2898DeriveBytes("test-pin", salt, 100000, HashAlgorithmName.SHA256))
        {
            byte[] actual = derive.GetBytes(32);
            byte[] expected = HexToBytes("d81c28e8b324b6d4c84fa2ca2cc9f76aae2002990920b55fc47805bccb31b051");
            return FixedTimeEquals(actual, expected) ? 0 : 9;
        }
    }

    private static int AuthorizeUpgrade()
    {
        DeleteAuthorization();
        if (!PromptAndVerify()) return 4;
        Directory.CreateDirectory(AdminDir);
        File.WriteAllText(AuthorizationPath, DateTime.UtcNow.Ticks.ToString(), new UTF8Encoding(false));
        return 0;
    }

    private static bool PromptAndVerify()
    {
        string pin = PromptForPin();
        if (pin == null) return false;
        bool ok = VerifyPin(pin);
        if (!ok && lastDiagnostic == "secret-access-denied") ok = VerifyPinViaSystem(pin);
        WriteDiagnostic(lastDiagnostic);
        if (!ok)
        {
            MessageBox.Show("PIN을 확인할 수 없습니다.\r\n진단: " + lastDiagnostic,
                ProductName + " 설치",
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        return ok;
    }

    private static bool VerifyPinViaSystem(string pin)
    {
        bool matched;
        if (!RequestSystem("verify", pin, out matched)) return false;
        lastDiagnostic = matched ? "ok-system" : "pin-mismatch-system";
        return matched;
    }

    private static int RecoverPin()
    {
        string first;
        string second;
        if (!PromptForNewPin(out first, out second)) return 4;
        if (first.Length != 4 || !IsDigits(first) || first != second)
        {
            MessageBox.Show("새 PIN은 숫자 4자리이며 두 입력이 같아야 합니다.",
                ProductName + " PIN 복구", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 4;
        }
        bool reset;
        if (!RequestSystem("reset", first, out reset) || !reset)
        {
            WriteDiagnostic(lastDiagnostic);
            MessageBox.Show("보호 PIN을 재설정하지 못했습니다.\r\n진단: " + lastDiagnostic,
                ProductName + " PIN 복구", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 8;
        }
        lastDiagnostic = "pin-reset-system";
        WriteDiagnostic(lastDiagnostic);
        MessageBox.Show("보호 PIN이 안전하게 재설정되었습니다.", ProductName + " PIN 복구",
            MessageBoxButtons.OK, MessageBoxIcon.Information);
        return 0;
    }

    private static int DiagnoseProtection()
    {
        bool healthy;
        if (!RequestSystem("diagnose", "", out healthy))
        {
            WriteDiagnostic(lastDiagnostic);
            return 11;
        }
        WriteDiagnostic(lastDiagnostic);
        return healthy ? 0 : 11;
    }

    private static int RepairProtection()
    {
        bool healthy;
        if (!RequestSystem("repair-protection", "", out healthy))
        {
            WriteDiagnostic(lastDiagnostic);
            return 12;
        }
        WriteDiagnostic(lastDiagnostic);
        return healthy ? 0 : 12;
    }

    private static bool RequestSystem(string operation, string value, out bool result)
    {
        result = false;
        string pipeName = "PlaytimePactInstallerAuth-" + Guid.NewGuid().ToString("N");
        string serviceExecutable = EnsureSystemVerifierExecutable();
        bool removeExecutable = !String.Equals(serviceExecutable, Environment.GetCommandLineArgs()[0], StringComparison.OrdinalIgnoreCase);
        var security = new PipeSecurity();
        security.AddAccessRule(new PipeAccessRule(
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(
            WindowsIdentity.GetCurrent().User,
            PipeAccessRights.FullControl, AccessControlType.Allow));

        try
        {
            RunQuiet("sc.exe", "delete " + VerificationServiceName, 5000);
            string createArguments = "create " + VerificationServiceName
                + " binPath= \"\\\"" + serviceExecutable + "\\\" --system-verify " + pipeName
                + "\" start= demand obj= LocalSystem";
            if (RunQuiet("sc.exe", createArguments, 10000) != 0)
            {
                lastDiagnostic = "system-verifier-create-failed";
                return false;
            }

            using (var server = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1,
                PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 1024, 1024, security))
            {
                IAsyncResult waiting = server.BeginWaitForConnection(null, null);
                int startResult = RunQuiet("sc.exe", "start " + VerificationServiceName, 10000);
                if (startResult != 0 || !waiting.AsyncWaitHandle.WaitOne(15000))
                {
                    lastDiagnostic = startResult != 0 ? "system-verifier-start-failed" : "system-verifier-timeout";
                    return false;
                }
                server.EndWaitForConnection(waiting);
                using (var writer = new BinaryWriter(server, Encoding.UTF8, true))
                using (var reader = new BinaryReader(server, Encoding.UTF8, true))
                {
                    writer.Write(operation);
                    writer.Write(value);
                    writer.Flush();
                    result = reader.ReadBoolean();
                    lastDiagnostic = reader.ReadString();
                    return true;
                }
            }
        }
        finally
        {
            RunQuiet("sc.exe", "stop " + VerificationServiceName, 5000);
            RunQuiet("sc.exe", "delete " + VerificationServiceName, 5000);
            if (removeExecutable)
            {
                try { File.Delete(serviceExecutable); } catch { }
            }
        }
    }

    private static string EnsureSystemVerifierExecutable()
    {
        string current = Path.GetFullPath(Environment.GetCommandLineArgs()[0]);
        string programFiles = Path.GetFullPath(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles))
            .TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        if (current.StartsWith(programFiles, StringComparison.OrdinalIgnoreCase)) return current;
        string targetDir = Path.Combine(programFiles, "Playtime Pact");
        Directory.CreateDirectory(targetDir);
        string target = Path.Combine(targetDir, "PlaytimePactInstallerAuth.exe");
        File.Copy(current, target, true);
        return target;
    }

    private sealed class SystemVerificationService : ServiceBase
    {
        private readonly string pipeName;
        internal SystemVerificationService(string pipe)
        {
            pipeName = pipe;
            ServiceName = VerificationServiceName;
            CanStop = true;
            AutoLog = true;
        }

        protected override void OnStart(string[] args)
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    using (var client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.None))
                    {
                        client.Connect(12000);
                        using (var reader = new BinaryReader(client, Encoding.UTF8, true))
                        using (var writer = new BinaryWriter(client, Encoding.UTF8, true))
                        {
                            string operation = reader.ReadString();
                            string value = reader.ReadString();
                            bool result = operation == "verify" ? VerifyPin(value)
                                : operation == "reset" ? WritePin(value)
                                : operation == "diagnose" ? DiagnoseProtectionAccess()
                                : operation == "repair-protection" ? RepairProtectionAccess() : false;
                            writer.Write(result);
                            writer.Write(lastDiagnostic ?? "system-no-detail");
                            writer.Flush();
                        }
                    }
                }
                catch { }
                finally { Stop(); }
            });
        }
    }

    private static int RunSystemVerifier(string[] args)
    {
        string pipe = ArgumentAfter(args, "--system-verify");
        if (String.IsNullOrEmpty(pipe)) return 10;
        ServiceBase.Run(new SystemVerificationService(pipe));
        return 0;
    }

    private static string ArgumentAfter(string[] args, string name)
    {
        for (int i = 0; i + 1 < args.Length; i++)
            if (String.Equals(args[i], name, StringComparison.OrdinalIgnoreCase)) return args[i + 1];
        return null;
    }

    private static string PromptForPin()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (var form = new Form())
        using (var label = new Label())
        using (var input = new TextBox())
        using (var ok = new Button())
        using (var cancel = new Button())
        {
            form.Text = ProductName + " - 부모 PIN 확인";
            form.Width = 380;
            form.Height = 170;
            form.FormBorderStyle = FormBorderStyle.FixedDialog;
            form.StartPosition = FormStartPosition.CenterScreen;
            form.MinimizeBox = false;
            form.MaximizeBox = false;
            form.TopMost = true;

            label.Text = "기존 버전을 업데이트하려면 부모 PIN을 입력하세요.";
            label.AutoSize = true;
            label.Left = 20;
            label.Top = 18;

            input.Left = 20;
            input.Top = 48;
            input.Width = 325;
            input.UseSystemPasswordChar = true;
            input.MaxLength = 64;

            ok.Text = "확인";
            ok.DialogResult = DialogResult.OK;
            ok.Left = 180;
            ok.Top = 82;
            ok.Width = 80;

            cancel.Text = "취소";
            cancel.DialogResult = DialogResult.Cancel;
            cancel.Left = 265;
            cancel.Top = 82;
            cancel.Width = 80;

            form.Controls.Add(label);
            form.Controls.Add(input);
            form.Controls.Add(ok);
            form.Controls.Add(cancel);
            form.AcceptButton = ok;
            form.CancelButton = cancel;
            form.Shown += delegate { input.Focus(); };

            return form.ShowDialog() == DialogResult.OK ? input.Text : null;
        }
    }

    private static bool PromptForNewPin(out string first, out string second)
    {
        first = null;
        second = null;
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using (var form = new Form())
        using (var firstLabel = new Label())
        using (var secondLabel = new Label())
        using (var firstInput = new TextBox())
        using (var secondInput = new TextBox())
        using (var ok = new Button())
        using (var cancel = new Button())
        {
            form.Text = ProductName + " - 부모 PIN 복구";
            form.Width = 400;
            form.Height = 225;
            form.FormBorderStyle = FormBorderStyle.FixedDialog;
            form.StartPosition = FormStartPosition.CenterScreen;
            form.MinimizeBox = false;
            form.MaximizeBox = false;
            form.TopMost = true;

            firstLabel.Text = "새 부모 PIN (숫자 4자리)";
            firstLabel.SetBounds(20, 18, 340, 20);
            firstInput.SetBounds(20, 40, 340, 25);
            firstInput.UseSystemPasswordChar = true;
            firstInput.MaxLength = 4;

            secondLabel.Text = "새 부모 PIN 다시 입력";
            secondLabel.SetBounds(20, 76, 340, 20);
            secondInput.SetBounds(20, 98, 340, 25);
            secondInput.UseSystemPasswordChar = true;
            secondInput.MaxLength = 4;

            ok.Text = "재설정";
            ok.DialogResult = DialogResult.OK;
            ok.SetBounds(195, 137, 80, 30);
            cancel.Text = "취소";
            cancel.DialogResult = DialogResult.Cancel;
            cancel.SetBounds(280, 137, 80, 30);

            form.Controls.AddRange(new Control[] { firstLabel, firstInput, secondLabel, secondInput, ok, cancel });
            form.AcceptButton = ok;
            form.CancelButton = cancel;
            form.Shown += delegate { firstInput.Focus(); };
            if (form.ShowDialog() != DialogResult.OK) return false;
            first = firstInput.Text;
            second = secondInput.Text;
            return true;
        }
    }

    private static bool WritePin(string pin)
    {
        string temporary = null;
        string backup = null;
        string stage = "validate";
        try
        {
            if (pin.Length != 4 || !IsDigits(pin)) { lastDiagnostic = "reset-pin-invalid"; return false; }
            stage = "directory";
            Directory.CreateDirectory(AdminDir);
            stage = "derive";
            byte[] salt = new byte[16];
            using (var random = RandomNumberGenerator.Create()) random.GetBytes(salt);
            byte[] hash;
            using (var derive = new Rfc2898DeriveBytes(pin, salt, 1500000, HashAlgorithmName.SHA256))
                hash = derive.GetBytes(32);
            var secret = new Dictionary<string, object>
            {
                { "schemaVersion", 1 }, { "algorithm", "pbkdf2-sha256" },
                { "iterations", 1500000 }, { "salt", Convert.ToBase64String(salt) },
                { "hash", BytesToHex(hash) }
            };
            string json = new JavaScriptSerializer().Serialize(secret);
            temporary = SecretPath + ".recovery-" + Guid.NewGuid().ToString("N") + ".tmp";
            stage = "temporary-write";
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                4096, FileOptions.WriteThrough))
            using (var writer = new StreamWriter(stream, new UTF8Encoding(false)))
                writer.Write(json);
            if (File.Exists(SecretPath))
            {
                stage = "original-acl";
                if (!EnsureSystemFullControl(SecretPath))
                {
                    lastDiagnostic = "reset-acl-repair-failed";
                    return false;
                }
                try { File.SetAttributes(SecretPath, FileAttributes.Normal); } catch { }
                backup = SecretPath + ".recovery-backup-" + Guid.NewGuid().ToString("N");
                stage = "original-backup";
                File.Move(SecretPath, backup);
            }
            stage = "publish";
            File.Move(temporary, SecretPath);
            temporary = null;
            stage = "acl";
            var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
            var fileSecurity = new FileSecurity();
            fileSecurity.SetAccessRuleProtection(true, false);
            fileSecurity.SetOwner(system);
            fileSecurity.AddAccessRule(new FileSystemAccessRule(system, FileSystemRights.FullControl,
                AccessControlType.Allow));
            File.SetAccessControl(SecretPath, fileSecurity);
            stage = "verify";
            bool verified = VerifyPin(pin);
            if (!verified)
            {
                if (File.Exists(SecretPath)) File.Delete(SecretPath);
                if (backup != null && File.Exists(backup)) File.Move(backup, SecretPath);
                backup = null;
                return false;
            }
            if (backup != null && File.Exists(backup)) File.Delete(backup);
            backup = null;
            foreach (string stale in Directory.GetFiles(AdminDir, "admin-secret.json.recovery-*.tmp"))
                try { File.Delete(stale); } catch { }
            lastDiagnostic = "pin-reset-system";
            return verified;
        }
        catch (UnauthorizedAccessException) { lastDiagnostic = "reset-access-" + stage; return false; }
        catch (IOException ex) { lastDiagnostic = "reset-io-" + stage + "-" + ex.HResult.ToString("x8"); return false; }
        catch (CryptographicException) { lastDiagnostic = "reset-crypto-error"; return false; }
        catch (Exception ex) { lastDiagnostic = "reset-" + ex.GetType().Name; return false; }
        finally
        {
            try { if (temporary != null && File.Exists(temporary)) File.Delete(temporary); } catch { }
            try
            {
                if (backup != null && File.Exists(backup) && !File.Exists(SecretPath)) File.Move(backup, SecretPath);
            }
            catch { }
        }
    }

    private static bool DiagnoseProtectionAccess()
    {
        var probes = new[]
        {
            new[] { Root, "root" },
            new[] { AdminDir, "admin" },
            new[] { Path.Combine(Root, "Data"), "data" },
            new[] { Path.Combine(Root, "Broker"), "broker" },
            new[] { Path.Combine(Root, "Broker", "Accounting"), "accounting" },
        };
        try
        {
            foreach (string[] probe in probes)
            {
                string directory = probe[0];
                string label = probe[1];
                if (!Directory.Exists(directory))
                {
                    lastDiagnostic = "protection-missing-" + label;
                    return false;
                }
                foreach (string file in Directory.GetFiles(directory))
                {
                    lastDiagnostic = "protection-read-" + label + "-" + SafeFileLabel(file);
                    using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read,
                        FileShare.ReadWrite | FileShare.Delete))
                    {
                        if (stream.Length > 0) stream.ReadByte();
                    }
                }
                lastDiagnostic = "protection-write-" + label;
                string temporary = Path.Combine(directory, ".access-probe-" + Guid.NewGuid().ToString("N") + ".tmp");
                File.WriteAllText(temporary, "probe", new UTF8Encoding(false));
                File.Delete(temporary);
            }
            lastDiagnostic = "protection-registry";
            using (RegistryKey key = Registry.LocalMachine.OpenSubKey(
                @"SOFTWARE\PlaytimePact\PolicySelectors", true))
            {
                if (key == null)
                {
                    using (RegistryKey created = Registry.LocalMachine.CreateSubKey(
                        @"SOFTWARE\PlaytimePact\PolicySelectors", RegistryKeyPermissionCheck.ReadWriteSubTree))
                    {
                        if (created == null) throw new UnauthorizedAccessException();
                    }
                }
            }
            lastDiagnostic = "protection-access-ok";
            return true;
        }
        catch (UnauthorizedAccessException) { lastDiagnostic += "-denied"; return false; }
        catch (IOException ex) { lastDiagnostic += "-io-" + ex.HResult.ToString("x8"); return false; }
        catch (Exception ex) { lastDiagnostic += "-" + ex.GetType().Name; return false; }
    }

    private static bool RepairProtectionAccess()
    {
        string broker = Path.Combine(Root, "Broker");
        string accounting = Path.Combine(broker, "Accounting");
        string data = Path.Combine(Root, "Data");
        try
        {
            // A damaged PIN-file ACL can stop both upgrade authentication and
            // service readiness. Repair metadata only; never rewrite the PIN.
            lastDiagnostic = "protection-repair-admin-directory";
            Directory.CreateDirectory(AdminDir);
            SetProtectedDirectoryAccess(AdminDir);
            foreach (string directory in Directory.GetDirectories(AdminDir, "*", SearchOption.AllDirectories))
            {
                lastDiagnostic = "protection-repair-admin-subdirectory";
                SetProtectedDirectoryAccess(directory);
            }
            foreach (string file in Directory.GetFiles(AdminDir, "*", SearchOption.AllDirectories))
            {
                lastDiagnostic = "protection-repair-admin-" + SafeFileLabel(file);
                SetProtectedFileAccess(file);
            }
            // Session history is shared across Windows accounts, unlike the
            // PIN and accounting secrets. Restore its intended Users:Modify ACL.
            lastDiagnostic = "protection-repair-data-directory";
            Directory.CreateDirectory(data);
            SetSharedDataDirectoryAccess(data);
            foreach (string directory in Directory.GetDirectories(data, "*", SearchOption.AllDirectories))
            {
                lastDiagnostic = "protection-repair-data-subdirectory";
                SetSharedDataDirectoryAccess(directory);
            }
            foreach (string file in Directory.GetFiles(data, "*", SearchOption.AllDirectories))
            {
                lastDiagnostic = "protection-repair-data-" + SafeFileLabel(file);
                SetSharedDataFileAccess(file);
            }
            lastDiagnostic = "protection-repair-broker-directory";
            Directory.CreateDirectory(accounting);
            SetProtectedDirectoryAccess(broker);
            SetProtectedDirectoryAccess(accounting);
            foreach (string directory in Directory.GetDirectories(broker, "*", SearchOption.AllDirectories))
            {
                lastDiagnostic = "protection-repair-broker-subdirectory";
                SetProtectedDirectoryAccess(directory);
            }
            foreach (string file in Directory.GetFiles(broker, "*", SearchOption.AllDirectories))
            {
                lastDiagnostic = "protection-repair-broker-" + SafeFileLabel(file);
                SetProtectedFileAccess(file);
            }
            bool healthy = DiagnoseProtectionAccess();
            if (healthy) lastDiagnostic = "protection-repair-ok";
            return healthy;
        }
        catch (UnauthorizedAccessException) { lastDiagnostic += "-denied"; return false; }
        catch (IOException ex) { lastDiagnostic += "-io-" + ex.HResult.ToString("x8"); return false; }
        catch (Exception ex) { lastDiagnostic += "-" + ex.GetType().Name; return false; }
    }

    private static void SetProtectedDirectoryAccess(string path)
    {
        if (!EnsureSystemFullControl(path)) throw new UnauthorizedAccessException();
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(true, false);
        security.SetOwner(system);
        const InheritanceFlags inheritance = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        security.AddAccessRule(new FileSystemAccessRule(system, FileSystemRights.FullControl,
            inheritance, PropagationFlags.None, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(administrators, FileSystemRights.FullControl,
            inheritance, PropagationFlags.None, AccessControlType.Allow));
        Directory.SetAccessControl(path, security);
    }

    private static void SetProtectedFileAccess(string path)
    {
        if (!EnsureSystemFullControl(path)) throw new UnauthorizedAccessException();
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        var security = new FileSecurity();
        security.SetAccessRuleProtection(true, false);
        security.SetOwner(system);
        security.AddAccessRule(new FileSystemAccessRule(system, FileSystemRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(administrators, FileSystemRights.FullControl, AccessControlType.Allow));
        File.SetAccessControl(path, security);
    }

    private static void SetSharedDataDirectoryAccess(string path)
    {
        if (!EnsureSystemFullControl(path)) throw new UnauthorizedAccessException();
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        var users = new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null);
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(true, false);
        security.SetOwner(system);
        const InheritanceFlags inheritance = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        security.AddAccessRule(new FileSystemAccessRule(system, FileSystemRights.FullControl,
            inheritance, PropagationFlags.None, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(administrators, FileSystemRights.FullControl,
            inheritance, PropagationFlags.None, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(users, FileSystemRights.Modify,
            inheritance, PropagationFlags.None, AccessControlType.Allow));
        Directory.SetAccessControl(path, security);
    }

    private static void SetSharedDataFileAccess(string path)
    {
        if (!EnsureSystemFullControl(path, true)) throw new UnauthorizedAccessException();
        lastDiagnostic += "-apply-acl";
        var system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
        var administrators = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
        var users = new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null);
        var security = new FileSecurity();
        security.SetAccessRuleProtection(true, false);
        security.SetOwner(administrators);
        security.AddAccessRule(new FileSystemAccessRule(system, FileSystemRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(administrators, FileSystemRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(users, FileSystemRights.Modify, AccessControlType.Allow));
        try
        {
            File.SetAccessControl(path, security);
        }
        catch (UnauthorizedAccessException)
        {
            // A stale explicit deny on a shared session file can survive a
            // grant and prevent .NET from replacing its DACL. Reset only the
            // ACL to the already-repaired parent directory; preserve bytes.
            lastDiagnostic += "-reset-acl";
            string quoted = "\"" + path + "\"";
            int reset = RunQuiet("icacls.exe", quoted + " /reset", 10000);
            if (reset != 0)
            {
                lastDiagnostic += "-exit-" + reset;
                throw;
            }
            lastDiagnostic += "-retry";
            File.SetAccessControl(path, security);
        }
    }

    private static string SafeFileLabel(string path)
    {
        string name = Path.GetFileName(path).ToLowerInvariant();
        if (name == "admin-secret.json") return "admin-secret";
        if (name == "daily-usage.key") return "usage-key";
        if (name == "daily-usage.json") return "daily-usage";
        if (name == "daily-usage.integrity") return "usage-integrity";
        if (name == "accounting.journal") return "accounting-journal";
        if (name == "desktop-usage.json") return "desktop-usage";
        if (name == "local-policy.json") return "local-policy";
        if (name == "sessions.json") return "sessions";
        if (name.StartsWith("local-policy.v")) return "local-policy-version";
        if (name.StartsWith("usage.v")) return "usage-version";
        return "other-file";
    }

    private static bool EnsureSystemFullControl(string path, bool allowAdministratorsOwner = false)
    {
        string quoted = "\"" + path + "\"";
        int owner = RunQuiet("icacls.exe", quoted + " /setowner *S-1-5-18", 10000);
        if (owner != 0)
        {
            // This helper runs as LocalSystem. Taking ownership for the
            // Administrators group (/A) leaves the SYSTEM process unable to
            // replace some damaged child-file DACLs. Claim it for SYSTEM.
            int take = RunQuiet("takeown.exe", "/F " + quoted, 10000);
            if (take != 0)
            {
                lastDiagnostic += "-setowner-exit-" + owner + "-takeown-exit-" + take;
                return false;
            }
            // takeown already made this service's current LocalSystem account
            // the owner. A second icacls /setowner can return access denied
            // even though SYSTEM now owns the file; continue to DACL repair.
            bool tookSystemOwnership = WindowsIdentity.GetCurrent().User.IsWellKnown(WellKnownSidType.LocalSystemSid);
            if (!tookSystemOwnership) owner = RunQuiet("icacls.exe", quoted + " /setowner *S-1-5-18", 10000);
            if (owner != 0 && !tookSystemOwnership && !allowAdministratorsOwner)
            {
                lastDiagnostic += "-setowner-retry-exit-" + owner;
                return false;
            }
        }
        int access = RunQuiet("icacls.exe", quoted + " /inheritance:r /grant:r *S-1-5-18:F", 10000);
        if (access != 0) lastDiagnostic += "-grant-exit-" + access;
        // As the file owner, SYSTEM can still replace its DACL through the
        // following SetAccessControl call if icacls rejects an intermediate
        // grant. A failed SetAccessControl remains a hard installation error.
        return access == 0 || owner == 0 || WindowsIdentity.GetCurrent().User.IsWellKnown(WellKnownSidType.LocalSystemSid);
    }

    private static bool IsDigits(string value)
    {
        foreach (char character in value) if (character < '0' || character > '9') return false;
        return true;
    }

    private static string BytesToHex(byte[] bytes)
    {
        var builder = new StringBuilder(bytes.Length * 2);
        foreach (byte value in bytes) builder.Append(value.ToString("x2"));
        return builder.ToString();
    }

    private static bool VerifyPin(string pin)
    {
        try
        {
            if (!File.Exists(SecretPath)) { lastDiagnostic = "secret-missing"; return false; }
            string json = File.ReadAllText(SecretPath, Encoding.UTF8);
            var parsed = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(json);

            object schema;
            object algorithm;
            if (parsed.TryGetValue("schemaVersion", out schema)
                && Convert.ToInt32(schema) == 1
                && parsed.TryGetValue("algorithm", out algorithm)
                && String.Equals(Convert.ToString(algorithm), "pbkdf2-sha256", StringComparison.Ordinal))
            {
                int iterations = Convert.ToInt32(parsed["iterations"]);
                if (iterations < 100000 || iterations > 10000000) { lastDiagnostic = "secret-iterations-invalid"; return false; }
                byte[] salt = Convert.FromBase64String(Convert.ToString(parsed["salt"]));
                byte[] expected = HexToBytes(Convert.ToString(parsed["hash"]));
                if (salt.Length < 8 || expected.Length != 32) { lastDiagnostic = "secret-format-invalid"; return false; }
                byte[] actual;
                using (var derive = new Rfc2898DeriveBytes(pin, salt, iterations, HashAlgorithmName.SHA256))
                {
                    actual = derive.GetBytes(32);
                }
                bool matched = FixedTimeEquals(actual, expected);
                lastDiagnostic = matched ? "ok" : "pin-mismatch";
                return matched;
            }

            object legacyHash;
            if (!parsed.TryGetValue("adminPasswordHash", out legacyHash)) { lastDiagnostic = "secret-schema-invalid"; return false; }
            byte[] legacyExpected = HexToBytes(Convert.ToString(legacyHash));
            if (legacyExpected.Length != 32) { lastDiagnostic = "secret-format-invalid"; return false; }
            using (var sha = SHA256.Create())
            {
                bool matched = FixedTimeEquals(sha.ComputeHash(Encoding.UTF8.GetBytes(pin)), legacyExpected);
                lastDiagnostic = matched ? "ok-legacy" : "pin-mismatch-legacy";
                return matched;
            }
        }
        catch (UnauthorizedAccessException) { lastDiagnostic = "secret-access-denied"; return false; }
        catch (IOException) { lastDiagnostic = "secret-io-error"; return false; }
        catch (FormatException) { lastDiagnostic = "secret-format-invalid"; return false; }
        catch (KeyNotFoundException) { lastDiagnostic = "secret-schema-invalid"; return false; }
        catch { lastDiagnostic = "secret-read-invalid"; return false; }
    }

    private static void WriteDiagnostic(string diagnostic)
    {
        try
        {
            Directory.CreateDirectory(Root);
            File.WriteAllText(DiagnosticPath,
                DateTime.UtcNow.ToString("o") + " result=" + diagnostic + Environment.NewLine,
                new UTF8Encoding(false));
        }
        catch { }
    }

    private static int CleanupLegacyUpgrade(string[] args)
    {
        if (!ConsumeFreshAuthorization()) return 6;

        Directory.CreateDirectory(Root);
        File.WriteAllText(Path.Combine(Root, "watchdog-disabled.flag"), "upgrade", new UTF8Encoding(false));

        using (var run = Registry.LocalMachine.OpenSubKey(
            @"Software\Microsoft\Windows\CurrentVersion\Run", true))
        {
            if (run != null) run.DeleteValue("PlaytimePact", false);
        }

        RunQuiet("schtasks.exe", "/delete /tn \"PlaytimePact\" /f", 10000);
        // The watchdog checks the disabled marker every three seconds. Waiting
        // here prevents it from racing the app shutdown and re-locking app.asar.
        Thread.Sleep(3500);
        string installDir = InstallDirectoryFromArgs(args);
        string wrapper = Path.Combine(installDir, "PlaytimePactPrivilegedBroker.exe");
        if (File.Exists(wrapper)) RunQuiet(wrapper, "stop", 25000);
        RunQuiet("sc.exe", "stop " + ServiceName, 15000);

        foreach (Process process in Process.GetProcessesByName("Playtime Pact"))
        {
            try { process.Kill(); process.WaitForExit(5000); } catch { }
        }
        return 0;
    }

    private static string InstallDirectoryFromArgs(string[] args)
    {
        string commandLine = Environment.CommandLine;
        int marker = commandLine.IndexOf(" _?=", StringComparison.OrdinalIgnoreCase);
        if (marker >= 0)
        {
            string value = commandLine.Substring(marker + 4).Trim().Trim('"');
            if (value.Length > 0)
                return value.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        }
        foreach (string arg in args)
        {
            if (arg.StartsWith("_?=", StringComparison.OrdinalIgnoreCase))
                return arg.Substring(3).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        }
        return AppDomain.CurrentDomain.BaseDirectory;
    }

    private static bool ConsumeFreshAuthorization()
    {
        try
        {
            if (!File.Exists(AuthorizationPath)) return false;
            long ticks;
            bool parsed = Int64.TryParse(File.ReadAllText(AuthorizationPath).Trim(), out ticks);
            File.Delete(AuthorizationPath);
            if (!parsed) return false;
            DateTime issued = new DateTime(ticks, DateTimeKind.Utc);
            TimeSpan age = DateTime.UtcNow - issued;
            return age >= TimeSpan.Zero && age <= TimeSpan.FromMinutes(5);
        }
        catch { return false; }
    }

    private static void DeleteAuthorization()
    {
        try { if (File.Exists(AuthorizationPath)) File.Delete(AuthorizationPath); } catch { }
    }

    private static int RunQuiet(string fileName, string arguments, int timeoutMs)
    {
        try
        {
            var start = new ProcessStartInfo(fileName, arguments)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            using (var process = Process.Start(start))
            {
                if (process == null) return -1;
                if (!process.WaitForExit(timeoutMs))
                {
                    try { process.Kill(); } catch { }
                    return -2;
                }
                return process.ExitCode;
            }
        }
        catch { return -3; }
    }

    private static bool IsAdministrator()
    {
        using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
        {
            return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
        }
    }

    private static bool HasArgument(string[] args, string wanted)
    {
        foreach (string arg in args)
            if (String.Equals(arg, wanted, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    private static byte[] HexToBytes(string hex)
    {
        if (String.IsNullOrEmpty(hex) || hex.Length != 64) return new byte[0];
        var result = new byte[hex.Length / 2];
        for (int i = 0; i < result.Length; i++)
            result[i] = Convert.ToByte(hex.Substring(i * 2, 2), 16);
        return result;
    }

    private static bool FixedTimeEquals(byte[] left, byte[] right)
    {
        int difference = left.Length ^ right.Length;
        int count = Math.Min(left.Length, right.Length);
        for (int i = 0; i < count; i++) difference |= left[i] ^ right[i];
        return difference == 0;
    }
}
