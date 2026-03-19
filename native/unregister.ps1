$HostName = "com.example.time_tracker"
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\$HostName" /f
Write-Host "Unregistered: $HostName"