' CustomerService.vb
' Synthetic, non-sensitive fixture for local-mcp-simple-server.
' Deliberately small: one class, one validation method, easy to describe
' in a sentence back to a reviewer.

Public Class CustomerService

    ''' <summary>
    ''' Accepts a customer record only when the name is non-empty, the email
    ''' contains exactly one "@" with text on both sides, and the phone
    ''' number has exactly 10 digits once formatting characters are removed.
    ''' </summary>
    Public Function ValidateCustomer(name As String, email As String, phone As String) As Boolean
        If String.IsNullOrWhiteSpace(name) Then
            Return False
        End If

        If Not IsValidEmail(email) Then
            Return False
        End If

        If Not IsValidPhone(phone) Then
            Return False
        End If

        Return True
    End Function

    Private Function IsValidEmail(email As String) As Boolean
        If String.IsNullOrEmpty(email) Then
            Return False
        End If

        Dim atIndex As Integer = email.IndexOf("@"c)
        Dim lastAtIndex As Integer = email.LastIndexOf("@"c)

        If atIndex <= 0 Then
            Return False
        End If

        If atIndex <> lastAtIndex Then
            Return False
        End If

        If atIndex = email.Length - 1 Then
            Return False
        End If

        Return True
    End Function

    Private Function IsValidPhone(phone As String) As Boolean
        If String.IsNullOrEmpty(phone) Then
            Return False
        End If

        Dim digitsOnly As New System.Text.StringBuilder()
        For Each c As Char In phone
            If Char.IsDigit(c) Then
                digitsOnly.Append(c)
            End If
        Next

        Return digitsOnly.Length = 10
    End Function

End Class
